import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { safeAudit } from "./audit.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";
import { isAfter } from "../state/timestamp-compare.js";
import { getEnvVar } from "../config.js";
import { drainPendingCompression } from "./pending-compression.js";

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SWEEP_CONCURRENCY = 4;
const MAX_SWEEP_CONCURRENCY = 32;

interface SweepPayload {
  dryRun?: boolean;
  maxAgeMs?: number;
  sessionIds?: string[];
  mode?: "finalize" | "idle-checkpoint";
}

interface SweepResult {
  swept: string[];
  checkpointed: string[];
  skipped: string[];
  failed: Array<{ sessionId: string; error: string }>;
  totalActive: number;
  totalCandidates: number;
  maxAgeMs: number;
  dryRun: boolean;
}

function resolveMaxAgeMs(payload?: SweepPayload): number {
  if (
    typeof payload?.maxAgeMs === "number" &&
    Number.isSafeInteger(payload.maxAgeMs) &&
    payload.maxAgeMs > 0
  ) {
    return payload.maxAgeMs;
  }
  const envRaw = getEnvVar("SESSION_SWEEP_MAX_AGE_MS");
  const envValue = envRaw?.trim();
  if (envValue && /^\d+$/.test(envValue)) {
    const envParsed = Number(envValue);
    if (Number.isSafeInteger(envParsed) && envParsed > 0) return envParsed;
  }
  return DEFAULT_MAX_AGE_MS;
}

function resolveSweepConcurrency(): number {
  const value = getEnvVar("SESSION_SWEEP_CONCURRENCY")?.trim();
  const parsed = value && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) &&
    parsed > 0 &&
    parsed <= MAX_SWEEP_CONCURRENCY
    ? parsed
    : DEFAULT_SWEEP_CONCURRENCY;
}

function activityAnchor(session: Session): string | null {
  return session.updatedAt ?? session.startedAt ?? null;
}

function effectiveWatermark(session: Session): string | null {
  return session.lastCheckpointAt ?? session.endedAt ?? null;
}

function sessionAgeMs(anchor: string, now: number): number | null {
  const anchorMs = new Date(anchor).getTime();
  if (!Number.isFinite(anchorMs)) return null;
  return now - anchorMs;
}

export function registerSessionSweepFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::session-sweep",
    async (data?: SweepPayload): Promise<SweepResult> =>
      withKeyedLock("session-sweep", async () => {
        const dryRun = data?.dryRun ?? false;
        const mode: "finalize" | "idle-checkpoint" =
          data?.mode === "idle-checkpoint" ? "idle-checkpoint" : "finalize";
        const maxAgeMs = resolveMaxAgeMs(data);
        const idFilter =
          data?.sessionIds && data.sessionIds.length > 0
            ? new Set(data.sessionIds)
            : null;

        const now = Date.now();
        const swept: string[] = [];
        const checkpointed: string[] = [];
        const skipped: string[] = [];
        const failed: Array<{ sessionId: string; error: string }> = [];

        const sessions = await kv.list<Session>(KV.sessions);
        const active = sessions.filter((s) => s.status === "active");
        const candidates =
          mode === "idle-checkpoint"
            ? sessions.filter((s) => s.status === "active")
            : sessions.filter(
                (s) => s.status === "active" || s.status === "completed",
              );
        const scoped = idFilter
          ? candidates.filter((s) => idFilter.has(s.id))
          : candidates;

        const processSession = async (session: Session): Promise<void> => {
          const anchor = activityAnchor(session);
          if (!anchor) {
            skipped.push(session.id);
            return;
          }
          const ageMs = sessionAgeMs(anchor, now);
          if (ageMs === null || ageMs <= maxAgeMs) {
            skipped.push(session.id);
            return;
          }
          const watermark = effectiveWatermark(session);
          if (
            dryRun &&
            watermark &&
            !isAfter(anchor, watermark) &&
            (mode === "idle-checkpoint" || session.status === "completed")
          ) {
            skipped.push(session.id);
            return;
          }

          if (dryRun) {
            if (mode === "idle-checkpoint" || session.status === "completed") {
              checkpointed.push(session.id);
            } else {
              swept.push(session.id);
            }
            return;
          }

          try {
            const outcome = await withKeyedLock(
              `obs:${session.id}`,
              async (): Promise<
                | { status: "skipped" }
                | {
                    status: "swept";
                    checkpointAt: string;
                    consolidated: boolean;
                  }
                | {
                    status: "checkpointed";
                    since: string | null;
                    checkpointAt: string;
                    kind: "idle" | "catchup";
                  }
              > => {
                const current = await kv.get<Session>(KV.sessions, session.id);
                if (!current) return { status: "skipped" };
                if (mode === "idle-checkpoint") {
                  if (current.status !== "active") return { status: "skipped" };
                } else if (
                  current.status !== "active" &&
                  current.status !== "completed"
                ) {
                  return { status: "skipped" };
                }
                const currentAnchor = activityAnchor(current);
                if (!currentAnchor) return { status: "skipped" };
                const currentAge = sessionAgeMs(currentAnchor, Date.now());
                if (currentAge === null || currentAge <= maxAgeMs) {
                  return { status: "skipped" };
                }
                const drain = await drainPendingCompression(
                  sdk,
                  kv,
                  session.id,
                );
                if (drain.remainingIds.length > 0) {
                  throw new Error(
                    `pending_compression_failed: ${drain.remainingIds.length} observation(s) remain`,
                  );
                }
                const recoveredPending = drain.completed > 0;
                const currentWatermark = effectiveWatermark(current);

                if (mode === "idle-checkpoint") {
                  if (
                    !recoveredPending &&
                    currentWatermark &&
                    !isAfter(currentAnchor, currentWatermark)
                  ) {
                    return { status: "skipped" };
                  }
                  await sdk.trigger({
                    function_id: "event::session::checkpoint",
                    payload: {
                      sessionId: session.id,
                      reason: "idle-checkpoint",
                      since: recoveredPending ? undefined : currentWatermark,
                      until: recoveredPending ? undefined : currentAnchor,
                      waitForCompletion: true,
                      summaryOnly: Boolean(current.parentSessionId),
                    },
                  });
                  await kv.update<Session>(KV.sessions, session.id, [
                    {
                      type: "set",
                      path: "lastCheckpointAt",
                      value: currentAnchor,
                    },
                  ]);
                  return {
                    status: "checkpointed",
                    since: recoveredPending ? null : currentWatermark,
                    checkpointAt: currentAnchor,
                    kind: "idle",
                  };
                }

                if (current.status === "completed") {
                  if (
                    !recoveredPending &&
                    currentWatermark &&
                    !isAfter(currentAnchor, currentWatermark)
                  ) {
                    return { status: "skipped" };
                  }
                  await sdk.trigger({
                    function_id: "event::session::checkpoint",
                    payload: {
                      sessionId: session.id,
                      reason: "sweep-catchup",
                      since: recoveredPending ? undefined : currentWatermark,
                      until: recoveredPending ? undefined : currentAnchor,
                      waitForCompletion: true,
                      summaryOnly: Boolean(current.parentSessionId),
                    },
                  });
                  await kv.update<Session>(KV.sessions, session.id, [
                    {
                      type: "set",
                      path: "lastCheckpointAt",
                      value: currentAnchor,
                    },
                  ]);
                  return {
                    status: "checkpointed",
                    since: recoveredPending ? null : currentWatermark,
                    checkpointAt: currentAnchor,
                    kind: "catchup",
                  };
                }

                const consolidated =
                  recoveredPending ||
                  !currentWatermark ||
                  isAfter(currentAnchor, currentWatermark);
                if (consolidated) {
                  await sdk.trigger({
                    function_id: "event::session::stopped",
                    payload: {
                      sessionId: session.id,
                      reason: "sweep-stale",
                      until: recoveredPending ? undefined : currentAnchor,
                      waitForCompletion: true,
                      summaryOnly: Boolean(current.parentSessionId),
                    },
                  });
                } else {
                  await sdk.trigger({
                    function_id: "event::session::stopped",
                    payload: {
                      sessionId: session.id,
                      reason: "sweep-finalize",
                      until: currentAnchor,
                      waitForCompletion: true,
                      summaryOnly: true,
                    },
                  });
                }
                const endedAt = new Date().toISOString();
                await kv.update<Session>(KV.sessions, session.id, [
                  { type: "set", path: "endedAt", value: endedAt },
                  { type: "set", path: "status", value: "completed" },
                  {
                    type: "set",
                    path: "lastCheckpointAt",
                    value: currentAnchor,
                  },
                ]);
                return {
                  status: "swept",
                  checkpointAt: currentAnchor,
                  consolidated,
                };
              },
            );

            if (outcome.status === "skipped") {
              skipped.push(session.id);
              return;
            }

            if (outcome.status === "swept") {
              swept.push(session.id);
              if (!outcome.consolidated) {
                logger.info(
                  "Session finalize marked done, no new activity since checkpoint",
                  { sessionId: session.id, checkpointAt: outcome.checkpointAt },
                );
              }
              await safeAudit(
                kv,
                "session_sweep",
                "mem::session-sweep",
                [session.id],
                {
                  reason: outcome.consolidated
                    ? "stale_active_session_closed"
                    : "stale_active_marked_done_no_activity",
                  maxAgeMs,
                  checkpointAt: outcome.checkpointAt,
                },
              );
            } else {
              checkpointed.push(session.id);
              if (outcome.kind === "idle") {
                logger.info("Session idle-checkpoint fired", {
                  sessionId: session.id,
                  since: outcome.since,
                  until: outcome.checkpointAt,
                });
              }
              await safeAudit(
                kv,
                "session_checkpoint",
                "mem::session-sweep",
                [session.id],
                {
                  reason:
                    outcome.kind === "idle"
                      ? "idle_checkpoint"
                      : "completed_session_post_close_activity",
                  maxAgeMs,
                  since: outcome.since,
                  until: outcome.checkpointAt,
                },
              );
            }
          } catch (err) {
            failed.push({
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        };

        const concurrency = resolveSweepConcurrency();
        for (
          let batchStart = 0;
          batchStart < scoped.length;
          batchStart += concurrency
        ) {
          await Promise.all(
            scoped
              .slice(batchStart, batchStart + concurrency)
              .map(processSession),
          );
        }

        const result: SweepResult = {
          swept,
          checkpointed,
          skipped,
          failed,
          totalActive: active.length,
          totalCandidates: candidates.length,
          maxAgeMs,
          dryRun,
        };

        logger.info("Session sweep complete", {
          mode,
          swept: swept.length,
          checkpointed: checkpointed.length,
          skipped: skipped.length,
          failed: failed.length,
          totalActive: active.length,
          totalCandidates: candidates.length,
          maxAgeMs,
          dryRun,
        });

        return result;
      }),
  );
}
