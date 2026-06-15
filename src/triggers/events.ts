import { TriggerAction, type ISdk } from "iii-sdk";
import type { CompressedObservation, HookPayload, Session } from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { isReflectEnabled } from "../functions/slots.js";
import { isGraphExtractionEnabled } from "../config.js";
import { logger } from "../logger.js";

let sessionStoppedQueue: Promise<void> = Promise.resolve();
let sessionStoppedQueueDepth = 0;

type SessionStoppedPayload = { sessionId: string; since?: string; until?: string; waitForCompletion?: boolean };
type SessionStoppedQueued = { queued: true; sessionId: string; queueDepth: number };
type QueuedSessionStopped = SessionStoppedQueued & { done: Promise<unknown> };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function enqueueSessionStopped(
  sessionId: string,
  run: () => Promise<unknown>,
): QueuedSessionStopped {
  const queueDepth = ++sessionStoppedQueueDepth;
  const previous = sessionStoppedQueue.catch((err) => {
    logger.error("Previous session stopped pipeline failed", {
      error: errorMessage(err),
    });
  });
  const done = previous.then(async () => {
    logger.info("Session stopped pipeline started", { sessionId, queueDepth });
    try {
      const result = await run();
      logger.info("Session stopped pipeline complete", { sessionId });
      return result;
    } catch (err) {
      const error = errorMessage(err);
      logger.error("Session stopped pipeline failed", {
        sessionId,
        error,
      });
      return { success: false, error };
    } finally {
      sessionStoppedQueueDepth = Math.max(0, sessionStoppedQueueDepth - 1);
    }
  });
  sessionStoppedQueue = done.then(() => undefined, () => undefined);
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
  }): Promise<unknown> => {
    const { sessionId, since, until } = params;
    const summary = await sdk.trigger({
      function_id: "mem::summarize",
      payload: { sessionId, ...(until ? { until } : {}) },
    });
    if (isReflectEnabled()) {
      try {
        sdk.trigger({
          function_id: "mem::slot-reflect",
          payload: { sessionId, ...(since ? { since } : {}), ...(until ? { until } : {}) },
          action: TriggerAction.Void(),
        });
      } catch (err) {
        logger.warn("slot-reflect trigger failed", { sessionId, error: errorMessage(err) });
      }
    }
    if (isGraphExtractionEnabled()) {
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
          });
        }
      } catch (err) {
        logger.warn("graph-extract trigger failed", { sessionId, error: errorMessage(err) });
      }
    }
    return summary;
  };

  sdk.registerFunction("event::session::stopped", async (data: SessionStoppedPayload) => {
    const queued = enqueueSessionStopped(data.sessionId, async () =>
      runSessionConsolidation({ sessionId: data.sessionId, since: data.since, until: data.until }),
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
    const queued = enqueueSessionStopped(data.sessionId, async () =>
      runSessionConsolidation({ sessionId: data.sessionId, since: data.since, until: data.until }),
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
      const anchor = existing?.updatedAt ?? existing?.startedAt ?? new Date().toISOString();
      const endedAt = new Date().toISOString();
      await kv.update(KV.sessions, data.sessionId, [
        { type: "set", path: "endedAt", value: endedAt },
        { type: "set", path: "status", value: "completed" },
        { type: "set", path: "lastCheckpointAt", value: anchor },
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
