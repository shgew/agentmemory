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
import { listSessionRawObservations } from "./raw-observations.js";
import { drainPendingImageReleases } from "./image-owner.js";
import { withImageOwnershipReadLock } from "./observation-lock.js";

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

type SweepMode = "finalize" | "idle-checkpoint";
type CheckpointKind = "idle" | "catchup" | "deferred-finalize";

type SweepOutcome =
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
      kind: CheckpointKind;
    };

interface SweepPlan {
  anchor: string;
  watermark: string | null;
  expectedStatus: Session["status"];
  kind: "idle" | "catchup" | "finalize";
  consolidated: boolean;
  consolidation: {
    functionId: "event::session::checkpoint" | "event::session::stopped";
    payload: Record<string, unknown>;
  };
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

function eligibleAnchor(
  session: Session,
  mode: SweepMode,
  maxAgeMs: number,
): string | null {
  if (mode === "idle-checkpoint") {
    if (session.status !== "active") return null;
  } else if (session.status !== "active" && session.status !== "completed") {
    return null;
  }
  const anchor = activityAnchor(session);
  if (!anchor) return null;
  const ageMs = sessionAgeMs(anchor, Date.now());
  return ageMs !== null && ageMs > maxAgeMs ? anchor : null;
}

export function registerSessionSweepFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::session-sweep",
    async (data?: SweepPayload): Promise<SweepResult> =>
      withKeyedLock("session-sweep", async () => {
        const dryRun = data?.dryRun ?? false;
        const mode: SweepMode =
          data?.mode === "idle-checkpoint" ? "idle-checkpoint" : "finalize";
        const maxAgeMs = resolveMaxAgeMs(data);
        const idFilter =
          data?.sessionIds && data.sessionIds.length > 0
            ? new Set(data.sessionIds)
            : null;

        if (!dryRun) {
          await drainPendingImageReleases(sdk, kv);
        }

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
            await withKeyedLock(`session:checkpoint:${session.id}`, async () => {
              const eligible = await withKeyedLock(
                `obs:${session.id}`,
                async () => {
                  const current = await kv.get<Session>(KV.sessions, session.id);
                  return current
                    ? eligibleAnchor(current, mode, maxAgeMs) !== null
                    : false;
                },
              );
              if (!eligible) {
                skipped.push(session.id);
                return;
              }
              const drain = await withImageOwnershipReadLock(async () =>
                drainPendingCompression(sdk, kv, session.id, {
                  rawPayloads: await listSessionRawObservations(kv, session.id),
                }),
              );
              if (drain.remainingIds.length > 0) {
                throw new Error(
                  `pending_compression_failed: ${drain.remainingIds.length} observation(s) remain`,
                );
              }
              const recoveredPending = drain.completed > 0;

              const preparation = await withKeyedLock(
                `obs:${session.id}`,
                async (): Promise<{ plan: SweepPlan } | { outcome: SweepOutcome }> => {
                  const current = await kv.get<Session>(KV.sessions, session.id);
                  if (!current) return { outcome: { status: "skipped" } };
                  const currentAnchor = eligibleAnchor(current, mode, maxAgeMs);
                  if (!currentAnchor) {
                    return { outcome: { status: "skipped" } };
                  }
                  const currentWatermark = effectiveWatermark(current);

                  if (mode === "idle-checkpoint") {
                    if (
                      !recoveredPending &&
                      currentWatermark &&
                      !isAfter(currentAnchor, currentWatermark)
                    ) {
                      return { outcome: { status: "skipped" } };
                    }
                    const consolidation = {
                      functionId: "event::session::checkpoint" as const,
                      payload: {
                        sessionId: session.id,
                        reason: "idle-checkpoint",
                        since: recoveredPending ? undefined : currentWatermark,
                        until: recoveredPending ? undefined : currentAnchor,
                        waitForCompletion: true,
                        summaryOnly: Boolean(current.parentSessionId),
                        pendingCompressionDrained: currentAnchor === anchor,
                        pendingCompressionRecovered: recoveredPending,
                      },
                    };
                    return {
                      plan: {
                        anchor: currentAnchor,
                        watermark: currentWatermark,
                        expectedStatus: current.status,
                        kind: "idle",
                        consolidated: true,
                        consolidation,
                      },
                    };
                  }

                  if (current.status === "completed") {
                    if (
                      !recoveredPending &&
                      currentWatermark &&
                      !isAfter(currentAnchor, currentWatermark)
                    ) {
                      return { outcome: { status: "skipped" } };
                    }
                    const consolidation = {
                      functionId: "event::session::checkpoint" as const,
                      payload: {
                        sessionId: session.id,
                        reason: "sweep-catchup",
                        since: recoveredPending ? undefined : currentWatermark,
                        until: recoveredPending ? undefined : currentAnchor,
                        waitForCompletion: true,
                        summaryOnly: Boolean(current.parentSessionId),
                        pendingCompressionDrained: currentAnchor === anchor,
                        pendingCompressionRecovered: recoveredPending,
                      },
                    };
                    return {
                      plan: {
                        anchor: currentAnchor,
                        watermark: currentWatermark,
                        expectedStatus: current.status,
                        kind: "catchup",
                        consolidated: true,
                        consolidation,
                      },
                    };
                  }

                  const consolidated =
                    recoveredPending ||
                    !currentWatermark ||
                    isAfter(currentAnchor, currentWatermark);
                  const consolidation = {
                    functionId: "event::session::stopped" as const,
                    payload: {
                      sessionId: session.id,
                      reason: consolidated ? "sweep-stale" : "sweep-finalize",
                      until:
                        consolidated && recoveredPending
                          ? undefined
                          : currentAnchor,
                      waitForCompletion: true,
                      summaryOnly: consolidated
                        ? Boolean(current.parentSessionId)
                        : true,
                      pendingCompressionDrained: currentAnchor === anchor,
                      pendingCompressionRecovered: recoveredPending,
                    },
                  };
                  return {
                    plan: {
                      anchor: currentAnchor,
                      watermark: currentWatermark,
                      expectedStatus: current.status,
                      kind: "finalize",
                      consolidated,
                      consolidation,
                    },
                  };
                },
              );

              if ("outcome" in preparation) {
                skipped.push(session.id);
                return;
              }

              const plan = preparation.plan;
              await sdk.trigger({
                function_id: plan.consolidation.functionId,
                payload: plan.consolidation.payload,
              });

              const outcome = await withKeyedLock(
                `obs:${session.id}`,
                async (): Promise<SweepOutcome> => {
                  const current = await kv.get<Session>(KV.sessions, session.id);
                  if (!current || current.status !== plan.expectedStatus) {
                    return { status: "skipped" };
                  }
                  const currentAnchor = activityAnchor(current);
                  if (currentAnchor !== plan.anchor) {
                    const currentWatermark = effectiveWatermark(current);
                    if (
                      !currentWatermark ||
                      isAfter(plan.anchor, currentWatermark)
                    ) {
                      await kv.update<Session>(KV.sessions, session.id, [
                        {
                          type: "set",
                          path: "lastCheckpointAt",
                          value: plan.anchor,
                        },
                      ]);
                    }
                    return {
                      status: "checkpointed",
                      since: recoveredPending ? null : plan.watermark,
                      checkpointAt: plan.anchor,
                      kind:
                        plan.kind === "finalize"
                          ? "deferred-finalize"
                          : plan.kind,
                    };
                  }

                  if (plan.kind === "finalize") {
                    const endedAt = new Date().toISOString();
                    await kv.update<Session>(KV.sessions, session.id, [
                      { type: "set", path: "endedAt", value: endedAt },
                      { type: "set", path: "status", value: "completed" },
                      {
                        type: "set",
                        path: "lastCheckpointAt",
                        value: plan.anchor,
                      },
                    ]);
                    return {
                      status: "swept",
                      checkpointAt: plan.anchor,
                      consolidated: plan.consolidated,
                    };
                  }

                  await kv.update<Session>(KV.sessions, session.id, [
                    {
                      type: "set",
                      path: "lastCheckpointAt",
                      value: plan.anchor,
                    },
                  ]);
                  return {
                    status: "checkpointed",
                    since: recoveredPending ? null : plan.watermark,
                    checkpointAt: plan.anchor,
                    kind: plan.kind,
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
                } else if (outcome.kind === "deferred-finalize") {
                  logger.info("Session finalize deferred by new activity", {
                    sessionId: session.id,
                    checkpointAt: outcome.checkpointAt,
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
                        : outcome.kind === "catchup"
                          ? "completed_session_post_close_activity"
                          : "stale_active_activity_advanced_during_finalize",
                    maxAgeMs,
                    since: outcome.since,
                    until: outcome.checkpointAt,
                  },
                );
              }
            });
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
