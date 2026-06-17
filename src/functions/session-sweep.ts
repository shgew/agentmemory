import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { safeAudit } from "./audit.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";
import { isAfter } from "../state/timestamp-compare.js";

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface SweepPayload {
  dryRun?: boolean;
  maxAgeMs?: number;
  sessionIds?: string[];
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
    async (data?: SweepPayload): Promise<SweepResult> => {
      const dryRun = data?.dryRun ?? false;
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
      const candidates = sessions.filter(
        (s) => s.status === "active" || s.status === "completed",
      );
      const scoped = idFilter
        ? candidates.filter((s) => idFilter.has(s.id))
        : candidates;

      for (const session of scoped) {
        const anchor = activityAnchor(session);
        if (!anchor) {
          skipped.push(session.id);
          continue;
        }
        const ageMs = sessionAgeMs(anchor, now);
        if (ageMs === null || ageMs <= maxAgeMs) {
          skipped.push(session.id);
          continue;
        }
        const watermark = effectiveWatermark(session);
        if (watermark && !isAfter(anchor, watermark)) {
          skipped.push(session.id);
          continue;
        }

        if (dryRun) {
          if (session.status === "active") {
            swept.push(session.id);
          } else {
            checkpointed.push(session.id);
          }
          continue;
        }

        try {
          const outcome = await withKeyedLock(
            `obs:${session.id}`,
            async (): Promise<
              | { status: "skipped" }
              | { status: "swept"; checkpointAt: string }
              | { status: "checkpointed"; since: string | null; checkpointAt: string }
            > => {
              const current = await kv.get<Session>(KV.sessions, session.id);
              if (!current) return { status: "skipped" };
              if (
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
              const currentWatermark = effectiveWatermark(current);
              if (currentWatermark && !isAfter(currentAnchor, currentWatermark)) {
                return { status: "skipped" };
              }

              if (current.status === "active") {
                await sdk.trigger({
                  function_id: "event::session::stopped",
                  payload: {
                    sessionId: session.id,
                    reason: "sweep-stale",
                    until: currentAnchor,
                    waitForCompletion: true,
                  },
                });
                const endedAt = new Date().toISOString();
                await kv.update<Session>(KV.sessions, session.id, [
                  { type: "set", path: "endedAt", value: endedAt },
                  { type: "set", path: "status", value: "completed" },
                  { type: "set", path: "lastCheckpointAt", value: currentAnchor },
                ]);
                return { status: "swept", checkpointAt: currentAnchor };
              }

              await sdk.trigger({
                function_id: "event::session::checkpoint",
                payload: {
                  sessionId: session.id,
                  reason: "sweep-catchup",
                  since: currentWatermark,
                  until: currentAnchor,
                  waitForCompletion: true,
                },
              });
              await kv.update<Session>(KV.sessions, session.id, [
                { type: "set", path: "lastCheckpointAt", value: currentAnchor },
              ]);
              return {
                status: "checkpointed",
                since: currentWatermark,
                checkpointAt: currentAnchor,
              };
            },
          );

          if (outcome.status === "skipped") {
            skipped.push(session.id);
            continue;
          }

          if (outcome.status === "swept") {
            swept.push(session.id);
            await safeAudit(
              kv,
              "session_sweep",
              "mem::session-sweep",
              [session.id],
              {
                reason: "stale_active_session_closed",
                maxAgeMs,
                checkpointAt: outcome.checkpointAt,
              },
            );
          } else {
            checkpointed.push(session.id);
            await safeAudit(
              kv,
              "session_checkpoint",
              "mem::session-sweep",
              [session.id],
              {
                reason: "completed_session_post_close_activity",
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
    },
  );
}
