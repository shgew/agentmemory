import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { safeAudit } from "./audit.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface SweepPayload {
  dryRun?: boolean;
  maxAgeMs?: number;
  sessionIds?: string[];
}

interface SweepResult {
  swept: string[];
  skipped: string[];
  failed: Array<{ sessionId: string; error: string }>;
  totalActive: number;
  maxAgeMs: number;
  dryRun: boolean;
}

function resolveMaxAgeMs(payload?: SweepPayload): number {
  if (typeof payload?.maxAgeMs === "number" && payload.maxAgeMs > 0) {
    return payload.maxAgeMs;
  }
  const envRaw = process.env.SESSION_SWEEP_MAX_AGE_MS;
  if (envRaw) {
    const envParsed = parseInt(envRaw, 10);
    if (Number.isFinite(envParsed) && envParsed > 0) return envParsed;
  }
  return DEFAULT_MAX_AGE_MS;
}

function sessionAgeMs(session: Session, now: number): number | null {
  const anchor = session.updatedAt ?? session.startedAt;
  if (!anchor) return null;
  const anchorMs = new Date(anchor).getTime();
  if (!Number.isFinite(anchorMs)) return null;
  return now - anchorMs;
}

export function registerSessionSweepFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::session-sweep",
    async (data?: SweepPayload): Promise<SweepResult> => {
      const dryRun = data?.dryRun ?? false;
      const maxAgeMs = resolveMaxAgeMs(data);
      const idFilter =
        data?.sessionIds && data.sessionIds.length > 0
          ? new Set(data.sessionIds)
          : null;

      const now = Date.now();
      const swept: string[] = [];
      const skipped: string[] = [];
      const failed: Array<{ sessionId: string; error: string }> = [];

      const sessions = await kv.list<Session>(KV.sessions);
      const active = sessions.filter((s) => s.status === "active");
      const scoped = idFilter
        ? active.filter((s) => idFilter.has(s.id))
        : active;

      for (const session of scoped) {
        const ageMs = sessionAgeMs(session, now);
        if (ageMs === null || ageMs <= maxAgeMs) {
          skipped.push(session.id);
          continue;
        }

        if (dryRun) {
          swept.push(session.id);
          continue;
        }

        try {
          const outcome = await withKeyedLock(
            `obs:${session.id}`,
            async (): Promise<
              | { status: "skipped" }
              | { status: "swept"; ageMs: number; anchor: "updatedAt" | "startedAt" }
            > => {
              const current = await kv.get<Session>(KV.sessions, session.id);
              if (!current || current.status !== "active") {
                return { status: "skipped" };
              }
              const currentAge = sessionAgeMs(current, Date.now());
              if (currentAge === null || currentAge <= maxAgeMs) {
                return { status: "skipped" };
              }
              const endedAt = new Date().toISOString();
              await kv.update<Session>(KV.sessions, session.id, [
                { type: "set", path: "endedAt", value: endedAt },
                { type: "set", path: "status", value: "completed" },
              ]);
              await sdk.trigger({
                function_id: "event::session::stopped",
                payload: { sessionId: session.id },
              });
              return {
                status: "swept",
                ageMs: currentAge,
                anchor: current.updatedAt ? "updatedAt" : "startedAt",
              };
            },
          );

          if (outcome.status === "skipped") {
            skipped.push(session.id);
            continue;
          }

          swept.push(session.id);
          await safeAudit(
            kv,
            "session_sweep",
            "mem::session-sweep",
            [session.id],
            {
              reason: "stale_active_session_swept",
              ageMs: outcome.ageMs,
              maxAgeMs,
              anchor: outcome.anchor,
            },
          );
        } catch (err) {
          failed.push({
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const result: SweepResult = {
        swept,
        skipped,
        failed,
        totalActive: active.length,
        maxAgeMs,
        dryRun,
      };

      logger.info("Session sweep complete", {
        swept: swept.length,
        skipped: skipped.length,
        failed: failed.length,
        totalActive: active.length,
        maxAgeMs,
        dryRun,
      });

      return result;
    },
  );
}
