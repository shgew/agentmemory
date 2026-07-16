import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isAfter } from "../state/timestamp-compare.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";
import { getIdleCheckpointMs } from "../config.js";
import { drainPendingCompression } from "./pending-compression.js";

interface SessionCheckpointPayload {
  sessionId?: string;
}

interface SessionCheckpointResult {
  success: boolean;
  queued?: boolean;
  noOp?: boolean;
  throttled?: boolean;
  retryAfterMs?: number;
  error?:
    | "session_not_found"
    | "session_not_active"
    | "session_has_no_activity"
    | "consolidation_failed";
  queueDepth?: number | null;
  lastCheckpointAt?: string;
}

interface SessionCheckpointPlan {
  anchor: string;
  consolidation: Promise<unknown>;
  consolidationSince?: string;
  consolidationUntil?: string;
}

export function registerSessionCheckpoint(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::session::checkpoint",
    async (
      data?: SessionCheckpointPayload,
    ): Promise<SessionCheckpointResult> => {
      const sessionId = data?.sessionId;
      if (!sessionId) {
        return { success: false, error: "session_not_found" };
      }

      return withKeyedLock(`session:checkpoint:${sessionId}`, async () => {
        const eligibility = await withKeyedLock(
          `obs:${sessionId}`,
          async (): Promise<SessionCheckpointResult | null> => {
            const session = await kv.get<Session>(KV.sessions, sessionId);
            if (!session) {
              return { success: false, error: "session_not_found" };
            }
            if (session.status !== "active") {
              return { success: false, error: "session_not_active" };
            }
            if (!(session.updatedAt ?? session.startedAt)) {
              return { success: false, error: "session_has_no_activity" };
            }
            return null;
          },
        );
        if (eligibility) return eligibility;

        let recoveredPending = false;
        try {
          const drain = await drainPendingCompression(sdk, kv, sessionId);
          if (drain.remainingIds.length > 0) {
            logger.error("Session checkpoint pending compression failed", {
              sessionId,
              remaining: drain.remainingIds.length,
            });
            return { success: false, error: "consolidation_failed" };
          }
          recoveredPending = drain.completed > 0;
        } catch (error) {
          logger.error("Session checkpoint pending compression drain failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          return { success: false, error: "consolidation_failed" };
        }

        const preparation = await withKeyedLock(
          `obs:${sessionId}`,
          async (): Promise<
            | { plan: SessionCheckpointPlan }
            | { result: SessionCheckpointResult }
          > => {
            const session = await kv.get<Session>(KV.sessions, sessionId);
            if (!session) {
              return {
                result: { success: false, error: "session_not_found" },
              };
            }
            if (session.status !== "active") {
              return {
                result: { success: false, error: "session_not_active" },
              };
            }

            const anchor = session.updatedAt ?? session.startedAt;
            if (!anchor) {
              return {
                result: {
                  success: false,
                  error: "session_has_no_activity",
                },
              };
            }

            const watermark = session.lastCheckpointAt ?? session.endedAt;
            if (
              !recoveredPending &&
              watermark !== undefined &&
              !isAfter(anchor, watermark)
            ) {
              logger.info(
                "Session checkpoint skipped, no new activity since last checkpoint",
                { sessionId, anchor, watermark },
              );
              return { result: { success: true, noOp: true } };
            }

            const idleThresholdMs = getIdleCheckpointMs();
            if (!recoveredPending && idleThresholdMs > 0) {
              const anchorMs = new Date(anchor).getTime();
              if (Number.isFinite(anchorMs)) {
                const idleMs = Date.now() - anchorMs;
                if (idleMs < idleThresholdMs) {
                  const retryAfterMs = idleThresholdMs - idleMs;
                  logger.info("Session checkpoint deferred by idle window", {
                    sessionId,
                    retryAfterMs,
                    idleThresholdMs,
                  });
                  return {
                    result: {
                      success: true,
                      throttled: true,
                      retryAfterMs,
                    },
                  };
                }
              }
            }

            const consolidationSince = recoveredPending
              ? undefined
              : watermark;
            const consolidationUntil = recoveredPending ? undefined : anchor;
            logger.info("Session checkpoint fired consolidation", {
              sessionId,
              since: consolidationSince,
              until: consolidationUntil,
            });
            const consolidation = sdk.trigger({
              function_id: "event::session::checkpoint",
              payload: {
                sessionId,
                since: consolidationSince,
                until: consolidationUntil,
                waitForCompletion: true,
              },
            });
            return {
              plan: {
                anchor,
                consolidation,
                consolidationSince,
                consolidationUntil,
              },
            };
          },
        );

        if ("result" in preparation) return preparation.result;

        const {
          anchor,
          consolidation,
          consolidationSince,
          consolidationUntil,
        } = preparation.plan;
        let result: unknown;
        try {
          result = await consolidation;
        } catch (error) {
          logger.error("Session checkpoint consolidation failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          return { success: false, error: "consolidation_failed" };
        }

        if (
          result &&
          typeof result === "object" &&
          (result as { success?: boolean }).success === false
        ) {
          logger.error("Session checkpoint consolidation failed", {
            sessionId,
            error: (result as { error?: unknown }).error ?? "unknown",
          });
          return { success: false, error: "consolidation_failed" };
        }

        const sessionExists = await withKeyedLock(
          `obs:${sessionId}`,
          async () => {
            const current = await kv.get<Session>(KV.sessions, sessionId);
            if (!current) return false;
            const currentWatermark =
              current.lastCheckpointAt ?? current.endedAt;
            if (!currentWatermark || isAfter(anchor, currentWatermark)) {
              await kv.update<Session>(KV.sessions, sessionId, [
                { type: "set", path: "lastCheckpointAt", value: anchor },
              ]);
            }
            return true;
          },
        );
        if (!sessionExists) {
          return { success: false, error: "session_not_found" };
        }

        await recordAudit(
          kv,
          "session_checkpoint",
          "mem::session::checkpoint",
          [sessionId],
          {
            since: consolidationSince,
            until: consolidationUntil,
          },
        );

        return {
          success: true,
          queued: true,
          queueDepth:
            (result as { queueDepth?: number } | undefined)?.queueDepth ?? null,
          lastCheckpointAt: anchor,
        };
      });
    },
  );
}
