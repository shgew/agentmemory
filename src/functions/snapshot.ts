import type { ISdk } from "iii-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SnapshotMeta,
  Session,
  Memory,
  GraphNode,
  AccessLogExport,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { VERSION } from "../version.js";
import { logger } from "../logger.js";
import {
  type AccessTarget,
  restoreOwnedAccessLogWithinOwnershipLock,
} from "./access-tracker.js";
import {
  withImageOwnershipReadLock,
  withObservationOwnerLock,
  withObservationSessionOwnershipLock,
} from "./observation-lock.js";

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

const execFileAsync = promisify(execFile);

async function gitExec(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trim();
}

async function ensureGitRepo(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(join(dir, ".git"))) {
    await gitExec(dir, ["init"]);
    await gitExec(dir, ["config", "user.email", "agentmemory@local"]);
    await gitExec(dir, ["config", "user.name", "agentmemory"]);
  }
}

export function registerSnapshotFunction(
  sdk: ISdk,
  kv: StateKV,
  snapshotDir: string,
): void {
  sdk.registerFunction("mem::snapshot-create", 
    async (data?: { message?: string }) => {

      try {
        await ensureGitRepo(snapshotDir);
        const ts = new Date().toISOString();

        const { sessions, memories, graphNodes, observations, accessLogs } =
          await withImageOwnershipReadLock(async () => {
            const sessions = await kv.list<Session>(KV.sessions);
            const memories = await kv.list<Memory>(KV.memories);
            const graphNodes = await kv.list<GraphNode>(KV.graphNodes);
            const observations: Record<string, unknown[]> = {};
            for (const session of sessions) {
              const obs = await kv
                .list(KV.observations(session.id))
                .catch(() => []);
              if (obs.length > 0) observations[session.id] = obs;
            }
            const ownerIds = new Set(memories.map((memory) => memory.id));
            for (const rows of Object.values(observations)) {
              for (const row of rows) {
                const id = (row as { id?: unknown }).id;
                if (typeof id === "string") ownerIds.add(id);
              }
            }
            const accessLogs = (
              await kv
                .list<AccessLogExport>(KV.accessLog)
                .catch(() => [] as AccessLogExport[])
            ).filter((log) => ownerIds.has(log.memoryId));
            return {
              sessions,
              memories,
              graphNodes,
              observations,
              accessLogs,
            };
          });

        const state = {
          version: VERSION,
          timestamp: ts,
          sessions,
          memories,
          graphNodes,
          observations,
          accessLogs,
        };

        writeFileSync(
          join(snapshotDir, "state.json"),
          JSON.stringify(state, null, 2),
          "utf-8",
        );

        await gitExec(snapshotDir, ["add", "."]);

        const message = data?.message || `Snapshot ${ts}`;
        try {
          await gitExec(snapshotDir, ["commit", "-m", message]);
        } catch (commitErr) {
          const errMsg =
            commitErr instanceof Error ? commitErr.message : String(commitErr);
          if (errMsg.includes("nothing to commit")) {
            return { success: true, message: "No changes to snapshot" };
          }
          throw commitErr;
        }

        const commitHash = await gitExec(snapshotDir, ["rev-parse", "HEAD"]);

        const meta: SnapshotMeta = {
          id: generateId("snap"),
          commitHash,
          createdAt: ts,
          message,
          stats: {
            sessions: sessions.length,
            observations: Object.values(observations).reduce(
              (sum, arr) => sum + arr.length,
              0,
            ),
            memories: memories.length,
            graphNodes: graphNodes.length,
          },
        };

        await recordAudit(kv, "export", "mem::snapshot-create", [meta.id], {
          commitHash,
          stats: meta.stats,
        });

        logger.info("Snapshot created", { commitHash });
        return { success: true, snapshot: meta };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );

  sdk.registerFunction("mem::snapshot-list",  async () => {
    try {
      if (!existsSync(join(snapshotDir, ".git"))) {
        return { snapshots: [] };
      }
      const log = await gitExec(snapshotDir, [
        "log",
        "--format=%H|%aI|%s",
        "-20",
      ]);
      const snapshots = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|");
          const [hash, date] = parts;
          const msg = parts.slice(2).join("|");
          return { commitHash: hash, createdAt: date, message: msg };
        });
      return { snapshots };
    } catch {
      return { snapshots: [] };
    }
  });

  sdk.registerFunction("mem::snapshot-restore", 
    async (data: { commitHash: string } | undefined) => {
      if (!data || typeof data.commitHash !== "string" || !data.commitHash.trim()) {
        return { success: false, error: "commitHash is required" };
      }
      if (!COMMIT_HASH_RE.test(data.commitHash)) {
        return { success: false, error: "Invalid commitHash format" };
      }

      try {
        await gitExec(snapshotDir, [
          "checkout",
          data.commitHash,
          "--",
          "state.json",
        ]);
        const content = readFileSync(join(snapshotDir, "state.json"), "utf-8");
        const state = JSON.parse(content) as {
          sessions?: Array<{ id: string } & Record<string, unknown>>;
          memories?: Array<{ id: string } & Record<string, unknown>>;
          graphNodes?: Array<{ id: string } & Record<string, unknown>>;
          observations?: Record<
            string,
            Array<{ id: string } & Record<string, unknown>>
          >;
          accessLogs?: AccessLogExport[];
        };

        const sessionsById = new Map(
          (state.sessions ?? []).map((session) => [session.id, session]),
        );
        const sessionIds = new Set([
          ...sessionsById.keys(),
          ...Object.keys(state.observations ?? {}),
        ]);
        const accessTargets = new Map<string, AccessTarget>();
        for (const memory of state.memories ?? []) {
          accessTargets.set(memory.id, { id: memory.id, scope: "memory" });
        }
        for (const [sessionId, observations] of Object.entries(
          state.observations ?? {},
        )) {
          for (const observation of observations) {
            accessTargets.set(observation.id, {
              id: observation.id,
              scope: "observation",
              sessionId,
            });
          }
        }
        await withObservationSessionOwnershipLock(sessionIds, async () => {
          for (const sessionId of sessionIds) {
            const session = sessionsById.get(sessionId);
            if (session) await kv.set(KV.sessions, sessionId, session);
            for (const observation of state.observations?.[sessionId] ?? []) {
              await withObservationOwnerLock(observation.id, async () => {
                await kv.set(
                  KV.observations(sessionId),
                  observation.id,
                  observation,
                );
              });
            }
          }
          for (const memory of state.memories ?? []) {
            await kv.set(KV.memories, memory.id, memory);
          }
          for (const node of state.graphNodes ?? []) {
            await kv.set(KV.graphNodes, node.id, node);
          }
          for (const log of state.accessLogs ?? []) {
            const target = accessTargets.get(log.memoryId);
            if (!target) continue;
            await restoreOwnedAccessLogWithinOwnershipLock(
              kv,
              target,
              log,
            );
          }
        });

        await gitExec(snapshotDir, ["checkout", "HEAD", "--", "state.json"]);

        await recordAudit(kv, "import", "mem::snapshot-restore", [], {
          commitHash: data.commitHash,
          sessions: state.sessions?.length || 0,
          memories: state.memories?.length || 0,
          graphNodes: state.graphNodes?.length || 0,
        });

        logger.info("Snapshot restored", {
          commitHash: data.commitHash,
        });
        return { success: true, commitHash: data.commitHash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot restore failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );
}
