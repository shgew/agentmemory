import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/slots.js", () => ({
  isReflectEnabled: () => false,
}));

vi.mock("../src/config.js", () => ({
  isGraphExtractionEnabled: () => true,
  getAgentId: () => undefined,
  getEnvVar: () => undefined,
  isAutoCompressEnabled: () => false,
}));

import { registerEventTriggers } from "../src/triggers/events.js";
import type { CompressedObservation } from "../src/types.js";
import { KV } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
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
      const existing =
        (store.get(scope)?.get(key) as Record<string, unknown>) ?? {};
      const next = { ...existing };
      for (const op of ops) if (op.type === "set") next[op.path] = op.value;
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
    trigger: async (input: { function_id: string; payload?: unknown }) => {
      calls.push({ function_id: input.function_id, payload: input.payload });
      const fn = functions.get(input.function_id);
      if (!fn) return {};
      return fn(input.payload);
    },
  };
}

function obs(id: string, timestamp: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_idle",
    timestamp,
    type: "file_edit",
    title: `obs ${id}`,
    facts: ["did something"],
    narrative: "narrative",
    concepts: ["c"],
    files: ["f.ts"],
    importance: 5,
  };
}

describe("idle-checkpoint consolidation skips summarize, keeps graph-extract", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    vi.clearAllMocks();
    sdk = mockSdk();
    kv = mockKV();
    registerEventTriggers(sdk as never, kv as never);
    await kv.set(
      KV.observations("ses_idle"),
      "obs_1",
      obs("obs_1", "2026-01-01T10:00:00Z"),
    );
    await kv.set(
      KV.observations("ses_idle"),
      "obs_2",
      obs("obs_2", "2026-01-01T11:00:00Z"),
    );
  });

  it("reason=idle-checkpoint runs graph-extract with the window but does NOT summarize", async () => {
    const result: unknown = await sdk.trigger({
      function_id: "event::session::checkpoint",
      payload: {
        sessionId: "ses_idle",
        reason: "idle-checkpoint",
        since: "2026-01-01T09:00:00Z",
        until: "2026-01-01T11:00:00Z",
        waitForCompletion: true,
      },
    });
    await result;

    const ids = sdk.calls.map((c) => c.function_id);
    expect(ids).toContain("mem::graph-extract");
    expect(ids).not.toContain("mem::summarize");

    const graphCall = sdk.calls.find(
      (c) => c.function_id === "mem::graph-extract",
    );
    expect(graphCall?.payload).toMatchObject({
      since: "2026-01-01T09:00:00Z",
      until: "2026-01-01T11:00:00Z",
    });
  });

  it("reason=checkpoint (reactive default) still calls summarize", async () => {
    const result: unknown = await sdk.trigger({
      function_id: "event::session::checkpoint",
      payload: {
        sessionId: "ses_idle",
        until: "2026-01-01T11:00:00Z",
        waitForCompletion: true,
      },
    });
    await result;

    expect(sdk.calls.map((c) => c.function_id)).toContain("mem::summarize");
  });

  it("event::session::stopped still calls summarize", async () => {
    const result: unknown = await sdk.trigger({
      function_id: "event::session::stopped",
      payload: {
        sessionId: "ses_idle",
        until: "2026-01-01T11:00:00Z",
        waitForCompletion: true,
      },
    });
    await result;

    expect(sdk.calls.map((c) => c.function_id)).toContain("mem::summarize");
  });
});
