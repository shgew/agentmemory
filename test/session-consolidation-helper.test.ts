import { describe, it, expect, beforeEach, vi } from "vitest";

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

type Call = { function_id: string; payload: unknown };

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
    trigger: async (input: { function_id: string; payload?: unknown; action?: unknown }) => {
      calls.push({ function_id: input.function_id, payload: input.payload });
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
