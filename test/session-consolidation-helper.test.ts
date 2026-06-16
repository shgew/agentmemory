import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/slots.js", () => ({
  isReflectEnabled: () => true,
}));

vi.mock("../src/config.js", () => ({
  isGraphExtractionEnabled: () => true,
  getAgentId: () => undefined,
  getEnvVar: () => undefined,
  isAutoCompressEnabled: () => false,
}));

import { registerEventTriggers } from "../src/triggers/events.js";
import type { Session, CompressedObservation } from "../src/types.js";
import { KV } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async <T>(
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ): Promise<T> => {
      const existing = (store.get(scope)?.get(key) as Record<string, unknown>) ?? {};
      const next = { ...existing };
      for (const op of ops) {
        if (op.type === "set") next[op.path] = op.value;
      }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, next);
      return next as T;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

type Call = { function_id: string; payload: unknown; timeoutMs?: number };

function mockSdk() {
  const calls: Call[] = [];
  const functions = new Map<string, (data: unknown) => unknown>();
  return {
    calls,
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: (data: unknown) => unknown,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown; action?: unknown; timeoutMs?: number }) => {
      calls.push({ function_id: input.function_id, payload: input.payload, timeoutMs: input.timeoutMs });
      const fn = functions.get(input.function_id);
      if (!fn) return {};
      return fn(input.payload);
    },
  };
}

function makeObs(id: string, sessionId: string, timestamp: string): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp,
    type: "conversation",
    title: `obs ${id}`,
    facts: [],
    narrative: "",
    concepts: [],
    files: [],
    importance: 5,
  };
}

describe("event::session::stopped + checkpoint pipeline", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerEventTriggers(sdk as never, kv as never);
  });

  it("event::session::checkpoint is registered and routes through consolidation", async () => {
    const checkpointFn = (sdk as any).trigger;
    expect(checkpointFn).toBeDefined();
    const result = await sdk.trigger({
      function_id: "event::session::checkpoint",
      payload: { sessionId: "ses_test", since: "2026-01-01T10:00:00.000Z", until: "2026-01-01T11:00:00.000Z" },
    });
    expect(result).toBeDefined();
  });

  it("event::session::stopped passes since+until to slot-reflect and graph-extract, only until to summarize", async () => {
    const sessionId = "ses_window";
    const since = "2026-01-01T10:00:00.000Z";
    const until = "2026-01-01T11:00:00.000Z";
    await kv.set(KV.observations(sessionId), "obs_1", makeObs("obs_1", sessionId, until));

    const handler = (sdk as any).trigger;
    const result: any = await handler({
      function_id: "event::session::stopped",
      payload: { sessionId, since, until, waitForCompletion: true },
    });
    await result;

    const summarizeCall = sdk.calls.find((c) => c.function_id === "mem::summarize");
    const slotCall = sdk.calls.find((c) => c.function_id === "mem::slot-reflect");
    const graphCall = sdk.calls.find((c) => c.function_id === "mem::graph-extract");

    expect(summarizeCall).toBeDefined();
    expect((summarizeCall!.payload as any).sessionId).toBe(sessionId);
    expect((summarizeCall!.payload as any).until).toBe(until);
    expect((summarizeCall!.payload as any).since).toBeUndefined();

    expect(slotCall).toBeDefined();
    expect((slotCall!.payload as any).since).toBe(since);
    expect((slotCall!.payload as any).until).toBe(until);

    expect(graphCall).toBeDefined();
    expect((graphCall!.payload as any).since).toBe(since);
    expect((graphCall!.payload as any).until).toBe(until);
  });

  it("event::session::checkpoint runs same consolidation as stopped via shared queue", async () => {
    const sessionId = "ses_cp";
    const since = "2026-01-01T10:00:00.000Z";
    const until = "2026-01-01T11:00:00.000Z";
    await kv.set(KV.observations(sessionId), "obs_cp", makeObs("obs_cp", sessionId, until));

    const result: any = await sdk.trigger({
      function_id: "event::session::checkpoint",
      payload: { sessionId, since, until, waitForCompletion: true },
    });
    await result;

    const summarizeCall = sdk.calls.find((c) => c.function_id === "mem::summarize");
    const slotCall = sdk.calls.find((c) => c.function_id === "mem::slot-reflect");
    const graphCall = sdk.calls.find((c) => c.function_id === "mem::graph-extract");

    expect(summarizeCall).toBeDefined();
    expect(slotCall).toBeDefined();
    expect((slotCall!.payload as any).since).toBe(since);
    expect((slotCall!.payload as any).until).toBe(until);
    expect(graphCall).toBeDefined();
  });

  it("event::session::ended hydrates lastCheckpointAt from activity anchor", async () => {
    const sessionId = "ses_ended";
    const startedAt = "2026-01-01T09:00:00.000Z";
    const updatedAt = "2026-01-01T17:00:00.000Z";
    const session: Session = {
      id: sessionId,
      project: "test",
      cwd: "/tmp",
      startedAt,
      updatedAt,
      status: "active",
      observationCount: 1,
    };
    await kv.set(KV.sessions, sessionId, session);

    await sdk.trigger({
      function_id: "event::session::ended",
      payload: { sessionId },
    });

    const updated = await kv.get<Session>(KV.sessions, sessionId);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("completed");
    expect(updated!.endedAt).toBeDefined();
    expect(updated!.lastCheckpointAt).toBe(updatedAt);
  });

  it("event::session::ended falls back to startedAt when updatedAt absent", async () => {
    const sessionId = "ses_no_updated";
    const startedAt = "2026-01-01T09:00:00.000Z";
    const session: Session = {
      id: sessionId,
      project: "test",
      cwd: "/tmp",
      startedAt,
      status: "active",
      observationCount: 0,
    };
    await kv.set(KV.sessions, sessionId, session);

    await sdk.trigger({
      function_id: "event::session::ended",
      payload: { sessionId },
    });

    const updated = await kv.get<Session>(KV.sessions, sessionId);
    expect(updated!.lastCheckpointAt).toBe(startedAt);
  });
});

describe("event::session::ended S4 (already-completed paths)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerEventTriggers(sdk as never, kv as never);
  });

  it("on already-completed session with post-close activity: fires checkpoint, preserves endedAt, advances lastCheckpointAt", async () => {
    const sessionId = "ses_S4_active_resume";
    const initialEndedAt = "2026-01-01T17:00:00.000Z";
    const initialCheckpointAt = "2026-01-01T17:00:00.000Z";
    const postActivityTs = "2026-01-02T09:00:00.000Z";
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "test",
      cwd: "/tmp",
      startedAt: "2026-01-01T09:00:00.000Z",
      endedAt: initialEndedAt,
      lastCheckpointAt: initialCheckpointAt,
      updatedAt: postActivityTs,
      status: "completed",
      observationCount: 5,
    } satisfies Session);

    sdk.calls.length = 0;
    await sdk.trigger({
      function_id: "event::session::ended",
      payload: { sessionId },
    });

    const updated = await kv.get<Session>(KV.sessions, sessionId);
    expect(updated!.status).toBe("completed");
    expect(updated!.endedAt).toBe(initialEndedAt);
    expect(updated!.lastCheckpointAt).toBe(postActivityTs);

    const stoppedCalls = sdk.calls.filter((c) => c.function_id === "event::session::stopped");
    const checkpointCalls = sdk.calls.filter((c) => c.function_id === "event::session::checkpoint");
    expect(stoppedCalls).toHaveLength(0);
    expect(checkpointCalls).toHaveLength(1);
    expect((checkpointCalls[0].payload as any).since).toBe(initialCheckpointAt);
    expect((checkpointCalls[0].payload as any).until).toBe(postActivityTs);
  });

  it("on already-completed session without post-close activity: no-op, no events", async () => {
    const sessionId = "ses_S4_no_activity";
    const ts = "2026-01-01T17:00:00.000Z";
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "test",
      cwd: "/tmp",
      startedAt: "2026-01-01T09:00:00.000Z",
      endedAt: ts,
      lastCheckpointAt: ts,
      updatedAt: ts,
      status: "completed",
      observationCount: 1,
    } satisfies Session);

    sdk.calls.length = 0;
    await sdk.trigger({
      function_id: "event::session::ended",
      payload: { sessionId },
    });

    const updated = await kv.get<Session>(KV.sessions, sessionId);
    expect(updated!.endedAt).toBe(ts);
    expect(updated!.lastCheckpointAt).toBe(ts);

    const stoppedCalls = sdk.calls.filter((c) => c.function_id === "event::session::stopped");
    const checkpointCalls = sdk.calls.filter((c) => c.function_id === "event::session::checkpoint");
    expect(stoppedCalls).toHaveLength(0);
    expect(checkpointCalls).toHaveLength(0);
  });

  it("on active session: fresh lifecycle close - fires stopped, writes endedAt+lastCheckpointAt, status->completed", async () => {
    const sessionId = "ses_S4_fresh_close";
    const startedAt = "2026-01-01T09:00:00.000Z";
    const updatedAt = "2026-01-01T17:00:00.000Z";
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "test",
      cwd: "/tmp",
      startedAt,
      updatedAt,
      status: "active",
      observationCount: 1,
    } satisfies Session);

    sdk.calls.length = 0;
    await sdk.trigger({
      function_id: "event::session::ended",
      payload: { sessionId },
    });

    const updated = await kv.get<Session>(KV.sessions, sessionId);
    expect(updated!.status).toBe("completed");
    expect(updated!.endedAt).toBeDefined();
    expect(updated!.lastCheckpointAt).toBe(updatedAt);

    const stoppedCalls = sdk.calls.filter((c) => c.function_id === "event::session::stopped");
    const checkpointCalls = sdk.calls.filter((c) => c.function_id === "event::session::checkpoint");
    expect(stoppedCalls).toHaveLength(1);
    expect((stoppedCalls[0].payload as any).until).toBe(updatedAt);
    expect(checkpointCalls).toHaveLength(0);
  });
});

describe("event::session::stopped passes timeoutMs to mem::summarize", () => {
  const ORIGINAL_ENV = { ...process.env };
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    delete process.env.AGENTMEMORY_SUMMARIZE_TIMEOUT_MS;
    sdk = mockSdk();
    kv = mockKV();
    registerEventTriggers(sdk as never, kv as never);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("dispatches mem::summarize with default timeoutMs=180000 when env unset", async () => {
    const sessionId = "ses_timeout_default";
    await kv.set(
      KV.observations(sessionId),
      "obs_1",
      makeObs("obs_1", sessionId, "2026-01-01T10:00:00.000Z"),
    );

    const result: any = await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId, waitForCompletion: true },
    });
    await result;

    const summarizeCall = sdk.calls.find((c) => c.function_id === "mem::summarize");
    expect(summarizeCall).toBeDefined();
    expect(summarizeCall!.timeoutMs).toBe(180000);
  });

  it("dispatches mem::summarize with overridden timeoutMs when env set", async () => {
    process.env.AGENTMEMORY_SUMMARIZE_TIMEOUT_MS = "600000";
    const sessionId = "ses_timeout_override";
    await kv.set(
      KV.observations(sessionId),
      "obs_1",
      makeObs("obs_1", sessionId, "2026-01-01T10:00:00.000Z"),
    );

    const result: any = await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId, waitForCompletion: true },
    });
    await result;

    const summarizeCall = sdk.calls.find((c) => c.function_id === "mem::summarize");
    expect(summarizeCall).toBeDefined();
    expect(summarizeCall!.timeoutMs).toBe(600000);
  });
});
