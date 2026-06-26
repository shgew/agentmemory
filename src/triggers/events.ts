import { TriggerAction, type ISdk } from "iii-sdk";
import type { CompressedObservation, HookPayload, Session } from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { isReflectEnabled } from "../functions/slots.js";
import { isGraphExtractionEnabled } from "../config.js";
import { logger } from "../logger.js";
import { isAfter } from "../state/timestamp-compare.js";
import { getSummarizeTimeoutMs } from "../functions/summarize.js";
import { getGraphExtractTimeoutMs } from "../functions/graph.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

// Consolidation runs through a bounded pool (CONSOLIDATION_CONCURRENCY, default
// 1 = serial). Each task holds withKeyedLock("session:consolidate:<id>") so two
// events for the same session never overlap, while distinct sessions run up to
// the cap concurrently. A finishing task hands its slot straight to the next
// pending task so the active count never exceeds the cap under a racing enqueue.
let activeConsolidations = 0;
const pendingConsolidations: Array<() => void> = [];

const CONSOLIDATION_CONCURRENCY_DEFAULT = 1;

function consolidationConcurrency(): number {
  const raw = process.env.CONSOLIDATION_CONCURRENCY;
  if (!raw) return CONSOLIDATION_CONCURRENCY_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CONSOLIDATION_CONCURRENCY_DEFAULT;
}

const consolidationLimit = consolidationConcurrency();

type SessionStoppedPayload = { sessionId: string; since?: string; until?: string; waitForCompletion?: boolean; reason?: string };
type SessionStoppedQueued = { queued: true; sessionId: string; queueDepth: number };
type QueuedSessionStopped = SessionStoppedQueued & { done: Promise<unknown> };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function enqueueSessionStopped(
  sessionId: string,
  reason: string,
  run: () => Promise<unknown>,
): QueuedSessionStopped {
  const queueDepth =
    activeConsolidations + pendingConsolidations.length + 1;

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
      const session: Session = {
        id: data.sessionId,
        project: data.project,
        cwd: data.cwd,
        startedAt: new Date().toISOString(),
        status: "active",
        observationCount: 0,
      };
      await kv.set(KV.sessions, data.sessionId, session);
      const contextResult = await sdk.trigger<
        { sessionId: string; project: string },
        { context: string }
      >({
        function_id: "mem::context",
        payload: { sessionId: data.sessionId, project: data.project },
      });
      return { session, context: contextResult.context };
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
  }): Promise<unknown> => {
    const { sessionId, since, until, reason } = params;
    // Idle checkpoints fire every few minutes for every active session and
    // only need the windowed graph-extract. Re-running the full-session
    // summarize on each one is the O(N^2) drain that lets the consolidation
    // backlog outpace intake. The final summary is produced on session stop
    // or end; until then the graph and raw observations stay current.
    const shouldSummarize = reason !== "idle-checkpoint";
    const graphPromise: Promise<void> = isGraphExtractionEnabled()
      ? (async () => {
          try {
            const observations = await kv.list<CompressedObservation>(
              KV.observations(sessionId),
            );
            const compressed = observations.filter((o) => o.title);
            if (compressed.length > 0) {
              await sdk.trigger({
                function_id: "mem::graph-extract",
                payload: {
                  observations: compressed,
                  ...(since ? { since } : {}),
                  ...(until ? { until } : {}),
                },
                timeoutMs: getGraphExtractTimeoutMs(),
              });
            }
          } catch (err) {
            logger.warn("graph-extract trigger failed", {
              sessionId,
              error: errorMessage(err),
            });
          }
        })()
      : Promise.resolve();

    let summarizeError: Error | null = null;
    let summary: unknown;
    if (shouldSummarize) {
      try {
        summary = await sdk.trigger({
          function_id: "mem::summarize",
          payload: { sessionId, ...(until ? { until } : {}) },
          timeoutMs: getSummarizeTimeoutMs(),
        });
        if (
          summary &&
          typeof summary === "object" &&
          (summary as { success?: boolean }).success === false
        ) {
          const error = (summary as { error?: string }).error ?? "unknown";
          if (error === "no_provider" || error === "no_observations") {
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

    if (!summarizeError && isReflectEnabled()) {
      try {
        await sdk.trigger({
          function_id: "mem::slot-reflect",
          payload: {
            sessionId,
            ...(since ? { since } : {}),
            ...(until ? { until } : {}),
          },
        });
      } catch (err) {
        logger.warn("slot-reflect trigger failed", {
          sessionId,
          error: errorMessage(err),
        });
      }
    }

    await graphPromise;

    if (summarizeError) throw summarizeError;
    return summary;
  };

  sdk.registerFunction("event::session::stopped", async (data: SessionStoppedPayload) => {
    const reason = data.reason ?? "stopped";
    const queued = enqueueSessionStopped(data.sessionId, reason, async () =>
      runSessionConsolidation({ sessionId: data.sessionId, since: data.since, until: data.until, reason }),
    );
    return data.waitForCompletion ? queued.done : {
      queued: true,
      sessionId: queued.sessionId,
      queueDepth: queued.queueDepth,
    };
  });
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::stopped",
    config: { topic: "agentmemory.session.stopped" },
  });

  sdk.registerFunction("event::session::checkpoint", async (data: SessionStoppedPayload) => {
    const reason = data.reason ?? "checkpoint";
    const queued = enqueueSessionStopped(data.sessionId, reason, async () =>
      runSessionConsolidation({ sessionId: data.sessionId, since: data.since, until: data.until, reason }),
    );
    return data.waitForCompletion ? queued.done : {
      queued: true,
      sessionId: queued.sessionId,
      queueDepth: queued.queueDepth,
    };
  });
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::checkpoint",
    config: { topic: "agentmemory.session.checkpoint" },
  });

  sdk.registerFunction(
    "event::session::ended",
    async (data: { sessionId: string }) => {
      const existing = await kv.get<Session>(KV.sessions, data.sessionId);
      if (!existing) return { success: false, error: "session_not_found" };
      const anchor = existing.updatedAt ?? existing.startedAt;

      if (existing.status === "completed") {
        const watermark = existing.lastCheckpointAt ?? existing.endedAt;
        if (anchor && isAfter(anchor, watermark)) {
          await sdk.trigger({
            function_id: "event::session::checkpoint",
            payload: {
              sessionId: data.sessionId,
              reason: "ended",
              since: watermark,
              until: anchor,
              waitForCompletion: true,
            },
          });
          await kv.update(KV.sessions, data.sessionId, [
            { type: "set", path: "lastCheckpointAt", value: anchor },
          ]);
          return { success: true, checkpointed: true };
        }
        return { success: true, alreadyCompleted: true };
      }

      const effectiveAnchor = anchor ?? new Date().toISOString();
      await sdk.trigger({
        function_id: "event::session::stopped",
        payload: {
          sessionId: data.sessionId,
          reason: "ended",
          until: effectiveAnchor,
          waitForCompletion: true,
        },
      });
      const endedAt = new Date().toISOString();
      await kv.update(KV.sessions, data.sessionId, [
        { type: "set", path: "endedAt", value: endedAt },
        { type: "set", path: "status", value: "completed" },
        { type: "set", path: "lastCheckpointAt", value: effectiveAnchor },
      ]);
      return { success: true };
    },
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
