import { TriggerAction, type ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  HookPayload,
  Session,
  SessionSummary,
} from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { isReflectEnabled } from "../functions/slots.js";
import { getEnvVar, isGraphExtractionEnabled } from "../config.js";
import { logger } from "../logger.js";
import { isAfter, isAtOrBefore } from "../state/timestamp-compare.js";
import { getSummarizeTimeoutMs } from "../functions/summarize.js";
import { getGraphExtractTimeoutMs } from "../functions/graph.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { upsertSession } from "../functions/session-upsert.js";
import { drainPendingCompression } from "../functions/pending-compression.js";

// Consolidation runs through a bounded pool (CONSOLIDATION_CONCURRENCY, default
// 1 = serial). Each task holds withKeyedLock("session:consolidate:<id>") so two
// events for the same session never overlap, while distinct sessions run up to
// the cap concurrently. A finishing task hands its slot straight to the next
// pending task so the active count never exceeds the cap under a racing enqueue.
let activeConsolidations = 0;
const pendingConsolidations: Array<() => void> = [];

const CONSOLIDATION_CONCURRENCY_DEFAULT = 1;
const CONSOLIDATION_CONCURRENCY_MAX = 32;

function consolidationConcurrency(): number {
  const value = getEnvVar("CONSOLIDATION_CONCURRENCY")?.trim();
  const parsed = value && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= CONSOLIDATION_CONCURRENCY_MAX
    ? parsed
    : CONSOLIDATION_CONCURRENCY_DEFAULT;
}

const consolidationLimit = consolidationConcurrency();

type SessionStoppedPayload = {
  sessionId: string;
  since?: string;
  until?: string;
  waitForCompletion?: boolean;
  reason?: string;
  summaryOnly?: boolean;
  pendingCompressionDrained?: boolean;
  pendingCompressionRecovered?: boolean;
};
type SessionStoppedQueued = {
  queued: true;
  sessionId: string;
  queueDepth: number;
};
type QueuedSessionStopped = SessionStoppedQueued & { done: Promise<unknown> };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function triggerFailure(functionId: string, result: unknown): Error | null {
  if (
    !result ||
    typeof result !== "object" ||
    (result as { success?: boolean }).success !== false
  ) {
    return null;
  }
  const error = (result as { error?: unknown }).error ?? "unknown";
  return new Error(`${functionId} returned failure: ${errorMessage(error)}`);
}

function enqueueSessionStopped(
  sessionId: string,
  reason: string,
  run: () => Promise<unknown>,
): QueuedSessionStopped {
  const queueDepth = activeConsolidations + pendingConsolidations.length + 1;

  const exec = async (): Promise<unknown> => {
    try {
      logger.info("Session consolidation pipeline started", {
        sessionId,
        reason,
        queueDepth,
      });
      const result = await withKeyedLock(
        `session:consolidate:${sessionId}`,
        run,
      );
      logger.info("Session consolidation pipeline complete", {
        sessionId,
        reason,
      });
      return result;
    } catch (err) {
      logger.error("Session consolidation pipeline failed", {
        sessionId,
        reason,
        error: errorMessage(err),
      });
      throw err;
    } finally {
      const next = pendingConsolidations.shift();
      if (next) {
        next();
      } else {
        activeConsolidations = Math.max(0, activeConsolidations - 1);
      }
    }
  };

  let done: Promise<unknown>;
  if (activeConsolidations < consolidationLimit) {
    activeConsolidations += 1;
    done = exec();
  } else {
    done = new Promise<void>((resolve) => {
      pendingConsolidations.push(resolve);
    }).then(exec);
  }

  // Sink rejections for fire-and-forget callers that discard the done
  // promise; awaiters via waitForCompletion still observe the rejection.
  void done.catch(() => {});
  return { queued: true, sessionId, queueDepth, done };
}

export function registerEventTriggers(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "event::session::started",
    async (data: { sessionId: string; project: string; cwd: string }) => {
      const { session, projectConflict, identityConflict } =
        await upsertSession(kv, data);
      if (identityConflict) {
        logger.warn("Session project conflict on start", {
          sessionId: data.sessionId,
          existingProject: session?.project,
          incomingProject: data.project,
        });
        return {
          success: false,
          error: `session identity conflict: ${identityConflict}`,
          session,
        };
      }
      if (!session) throw new Error("session upsert returned no session");
      const contextResult = await sdk.trigger<
        { sessionId: string; project: string },
        { context: string }
      >({
        function_id: "mem::context",
        payload: { sessionId: data.sessionId, project: session.project },
      });
      return { session, context: contextResult.context, projectConflict };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::started",
    config: { topic: "agentmemory.session.started" },
  });

  sdk.registerFunction("event::observation", async (data: HookPayload) =>
    sdk.trigger({ function_id: "mem::observe", payload: data }),
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::observation",
    config: { topic: "agentmemory.observation" },
  });

  const runSessionConsolidation = async (params: {
    sessionId: string;
    since?: string;
    until?: string;
    reason?: string;
    summaryOnly?: boolean;
    pendingCompressionDrained?: boolean;
    pendingCompressionRecovered?: boolean;
  }): Promise<unknown> => {
    const { sessionId, since, until, reason, summaryOnly } = params;
    // Idle checkpoints fire every few minutes for every active session and
    // only need the windowed graph-extract. Re-running the full-session
    // summarize on each one is the O(N^2) drain that lets the consolidation
    // backlog outpace intake. The final summary is produced on session stop
    // or end; until then the graph and raw observations stay current.
    let shouldSummarize = reason !== "idle-checkpoint";
    const session =
      summaryOnly === undefined
        ? await kv.get<Session>(KV.sessions, sessionId)
        : null;
    const runsFullConsolidation = !(
      summaryOnly ?? Boolean(session?.parentSessionId)
    );
    const runsGraphExtraction =
      runsFullConsolidation && isGraphExtractionEnabled();
    let windowSince = since;
    let windowUntil = until;
    let recoveredPending = params.pendingCompressionRecovered ?? false;
    if (shouldSummarize || runsGraphExtraction) {
      if (!params.pendingCompressionDrained) {
        const drain = await drainPendingCompression(sdk, kv, sessionId);
        if (drain.remainingIds.length > 0) {
          throw new Error(
            `pending_compression_failed: ${drain.remainingIds.length} observation(s) remain`,
          );
        }
        recoveredPending ||= drain.completed > 0;
      }
      if (recoveredPending) {
        windowSince = undefined;
        windowUntil = undefined;
      }
    }
    const observationsPromise =
      shouldSummarize || runsGraphExtraction
        ? kv.list<CompressedObservation>(KV.observations(sessionId))
        : Promise.resolve<CompressedObservation[]>([]);
    let expectedSummaryObservationCount: number | null = null;
    if (shouldSummarize) {
      const [existingSummary, observations] = await Promise.all([
        kv.get<SessionSummary>(KV.summaries, sessionId),
        observationsPromise,
      ]);
      expectedSummaryObservationCount = observations.length;
      shouldSummarize =
        existingSummary?.observationCount !== observations.length;
    }
    const graphPromise: Promise<Error | null> = runsGraphExtraction
      ? (async () => {
          try {
            const observations = await observationsPromise;
            const compressed = observations.filter(
              (observation) =>
                Boolean(observation.title) &&
                (!windowSince || isAfter(observation.timestamp, windowSince)) &&
                (!windowUntil ||
                  isAtOrBefore(observation.timestamp, windowUntil)),
            );
            if (compressed.length > 0) {
              const result = await sdk.trigger({
                function_id: "mem::graph-extract",
                payload: {
                  observations: compressed,
                  ...(windowSince ? { since: windowSince } : {}),
                  ...(windowUntil ? { until: windowUntil } : {}),
                },
                timeoutMs: getGraphExtractTimeoutMs(),
              });
              return triggerFailure("mem::graph-extract", result);
            }
            return null;
          } catch (err) {
            return err instanceof Error ? err : new Error(errorMessage(err));
          }
        })()
      : Promise.resolve(null);

    let summarizeError: Error | null = null;
    let summarizeWasNoOp = false;
    let summarizeNoOpReason: string | undefined;
    let summary: unknown;
    if (shouldSummarize) {
      try {
        summary = await sdk.trigger({
          function_id: "mem::summarize",
          payload: {
            sessionId,
            ...(windowUntil ? { until: windowUntil } : {}),
            pendingCompressionDrained: true,
            pendingCompressionRecovered: recoveredPending,
          },
          timeoutMs: getSummarizeTimeoutMs(),
        });
        if (
          summary &&
          typeof summary === "object" &&
          (summary as { success?: boolean }).success === false
        ) {
          const error = (summary as { error?: string }).error ?? "unknown";
          if (error === "no_provider" || error === "no_observations") {
            summarizeWasNoOp = true;
            summarizeNoOpReason = error;
            logger.info("Summarize skipped as no-op, pipeline continues", {
              sessionId,
              error,
            });
          } else {
            summarizeError = new Error(
              `mem::summarize returned failure: ${error}`,
            );
          }
        }
      } catch (err) {
        summarizeError =
          err instanceof Error ? err : new Error(errorMessage(err));
      }
    }

    if (reason === "sweep-finalize" && !summarizeError && !summarizeWasNoOp) {
      const summary = await kv.get<SessionSummary>(KV.summaries, sessionId);
      if (
        !summary ||
        summary.observationCount !== expectedSummaryObservationCount
      ) {
        summarizeError = new Error(
          "sweep-finalize did not persist a fresh session summary",
        );
      }
    }

    let reflectError: Error | null = null;
    if (runsFullConsolidation && !summarizeError && isReflectEnabled()) {
      try {
        const result = await sdk.trigger({
          function_id: "mem::slot-reflect",
          payload: {
            sessionId,
            ...(windowSince ? { since: windowSince } : {}),
            ...(windowUntil ? { until: windowUntil } : {}),
          },
        });
        reflectError = triggerFailure("mem::slot-reflect", result);
      } catch (err) {
        reflectError =
          err instanceof Error ? err : new Error(errorMessage(err));
      }
    }

    const graphError = await graphPromise;

    if (summarizeError) throw summarizeError;
    if (graphError) throw graphError;
    if (reflectError) throw reflectError;
    if (summarizeWasNoOp) {
      return { success: true, noOp: true, reason: summarizeNoOpReason };
    }
    return summary;
  };

  sdk.registerFunction(
    "event::session::stopped",
    async (data: SessionStoppedPayload) => {
      const reason = data.reason ?? "stopped";
      const queued = enqueueSessionStopped(data.sessionId, reason, async () =>
        runSessionConsolidation({
          sessionId: data.sessionId,
          since: data.since,
          until: data.until,
          reason,
          summaryOnly: data.summaryOnly,
          pendingCompressionDrained: data.pendingCompressionDrained,
          pendingCompressionRecovered: data.pendingCompressionRecovered,
        }),
      );
      return data.waitForCompletion
        ? queued.done
        : {
            queued: true,
            sessionId: queued.sessionId,
            queueDepth: queued.queueDepth,
          };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::stopped",
    config: { topic: "agentmemory.session.stopped" },
  });

  sdk.registerFunction(
    "event::session::checkpoint",
    async (data: SessionStoppedPayload) => {
      const reason = data.reason ?? "checkpoint";
      const queued = enqueueSessionStopped(data.sessionId, reason, async () =>
        runSessionConsolidation({
          sessionId: data.sessionId,
          since: data.since,
          until: data.until,
          reason,
          summaryOnly: data.summaryOnly,
          pendingCompressionDrained: data.pendingCompressionDrained,
          pendingCompressionRecovered: data.pendingCompressionRecovered,
        }),
      );
      return data.waitForCompletion
        ? queued.done
        : {
            queued: true,
            sessionId: queued.sessionId,
            queueDepth: queued.queueDepth,
          };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::checkpoint",
    config: { topic: "agentmemory.session.checkpoint" },
  });

  sdk.registerFunction(
    "event::session::ended",
    async (data: { sessionId: string }) =>
      withKeyedLock(`session:checkpoint:${data.sessionId}`, async () => {
        const preparation = await withKeyedLock(
          `obs:${data.sessionId}`,
          async () => {
            const session = await kv.get<Session>(KV.sessions, data.sessionId);
            if (!session) {
              return {
                result: { success: false, error: "session_not_found" },
              } as const;
            }
            const anchor = session.updatedAt ?? session.startedAt;
            if (session.status === "completed") {
              const watermark =
                session.lastCheckpointAt ?? session.endedAt;
              if (!anchor || !isAfter(anchor, watermark)) {
                return {
                  result: { success: true, alreadyCompleted: true },
                } as const;
              }
              return {
                plan: {
                  anchor,
                  expectedStatus: session.status,
                  kind: "checkpoint" as const,
                  watermark,
                },
              };
            }
            return {
              plan: {
                anchor: anchor ?? new Date().toISOString(),
                expectedStatus: session.status,
                kind: "end" as const,
                watermark: session.lastCheckpointAt ?? session.endedAt,
              },
            };
          },
        );

        if ("result" in preparation) return preparation.result;

        const { plan } = preparation;
        await sdk.trigger({
          function_id:
            plan.kind === "checkpoint"
              ? "event::session::checkpoint"
              : "event::session::stopped",
          payload: {
            sessionId: data.sessionId,
            reason: "ended",
            ...(plan.kind === "checkpoint" && plan.watermark
              ? { since: plan.watermark }
              : {}),
            until: plan.anchor,
            waitForCompletion: true,
          },
        });

        return withKeyedLock(`obs:${data.sessionId}`, async () => {
          const current = await kv.get<Session>(KV.sessions, data.sessionId);
          if (!current) {
            return { success: false, error: "session_not_found" };
          }
          const currentAnchor = current.updatedAt ?? current.startedAt;
          if (
            current.status !== plan.expectedStatus ||
            currentAnchor !== plan.anchor
          ) {
            const currentWatermark =
              current.lastCheckpointAt ?? current.endedAt;
            if (isAfter(plan.anchor, currentWatermark)) {
              await kv.update<Session>(KV.sessions, data.sessionId, [
                {
                  type: "set",
                  path: "lastCheckpointAt",
                  value: plan.anchor,
                },
              ]);
            }
            return {
              success: true,
              checkpointed: true,
              completionDeferred: current.status === "active",
            };
          }

          if (plan.kind === "checkpoint") {
            await kv.update<Session>(KV.sessions, data.sessionId, [
              {
                type: "set",
                path: "lastCheckpointAt",
                value: plan.anchor,
              },
            ]);
            return { success: true, checkpointed: true };
          }

          const endedAt = new Date().toISOString();
          await kv.update<Session>(KV.sessions, data.sessionId, [
            { type: "set", path: "endedAt", value: endedAt },
            { type: "set", path: "status", value: "completed" },
            {
              type: "set",
              path: "lastCheckpointAt",
              value: plan.anchor,
            },
          ]);
          return { success: true };
        });
      }),
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::ended",
    config: { topic: "agentmemory.session.ended" },
  });

  sdk.registerFunction(
    "event::session::observation-count-changed",
    async (payload: {
      key: string;
      event_type: string;
      old_value?: Session;
      new_value?: Session;
    }) => {
      if (payload.event_type === "delete") return { skipped: true };
      const oldCount = payload.old_value?.observationCount ?? 0;
      const newCount = payload.new_value?.observationCount ?? 0;
      if (newCount <= oldCount) return { skipped: true };

      await sdk.trigger({
        function_id: "stream::send",
        payload: {
          stream_name: STREAM.name,
          group_id: STREAM.viewerGroup,
          id: `session-activity-${payload.key}-${Date.now()}`,
          type: "session.activity",
          data: {
            sessionId: payload.key,
            observationCount: newCount,
            delta: newCount - oldCount,
            updatedAt: payload.new_value?.updatedAt ?? new Date().toISOString(),
          },
        },
        action: TriggerAction.Void(),
      });

      return { emitted: true };
    },
  );
  sdk.registerTrigger({
    type: "state",
    function_id: "event::session::observation-count-changed",
    config: { scope: KV.sessions },
  });
}
