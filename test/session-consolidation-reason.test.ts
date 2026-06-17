import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/slots.js", () => ({
  isReflectEnabled: () => false,
}));

vi.mock("../src/config.js", () => ({
  isGraphExtractionEnabled: () => false,
  getAgentId: () => undefined,
  getEnvVar: () => undefined,
  isAutoCompressEnabled: () => false,
}));

import { logger } from "../src/logger.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import type { Session } from "../src/types.js";
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
    trigger: async (input: { function_id: string; payload?: unknown }) => {
      calls.push({ function_id: input.function_id, payload: input.payload });
      const fn = functions.get(input.function_id);
      if (!fn) return {};
      return fn(input.payload);
    },
  };
}

describe("session consolidation pipeline reason labeling", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = mockSdk();
    kv = mockKV();
    registerEventTriggers(sdk as never, kv as never);
  });

  it("event::session::stopped logs the consolidation pipeline with reason 'stopped' by default", async () => {
    const sessionId = "ses_reason_stopped";
    const result: unknown = await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId, waitForCompletion: true },
    });
    await result;

    expect(logger.info).toHaveBeenCalledWith(
      "Session consolidation pipeline started",
      expect.objectContaining({ sessionId, reason: "stopped" }),
    );
  });

  it("event::session::checkpoint logs the consolidation pipeline with reason 'checkpoint' by default", async () => {
    const sessionId = "ses_reason_checkpoint";
    const result: unknown = await sdk.trigger({
      function_id: "event::session::checkpoint",
      payload: { sessionId, waitForCompletion: true },
    });
    await result;

    expect(logger.info).toHaveBeenCalledWith(
      "Session consolidation pipeline started",
      expect.objectContaining({ sessionId, reason: "checkpoint" }),
    );
  });

  it("threads an explicit reason from the payload into the pipeline log", async () => {
    const sessionId = "ses_reason_explicit";
    const result: unknown = await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId, reason: "ended", waitForCompletion: true },
    });
    await result;

    expect(logger.info).toHaveBeenCalledWith(
      "Session consolidation pipeline started",
      expect.objectContaining({ sessionId, reason: "ended" }),
    );
  });

  it("event::session::ended labels the downstream pipeline with reason 'ended'", async () => {
    const sessionId = "ses_reason_ended";
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "test",
      cwd: "/tmp",
      startedAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T17:00:00.000Z",
      status: "active",
      observationCount: 1,
    } satisfies Session);

    await sdk.trigger({
      function_id: "event::session::ended",
      payload: { sessionId },
    });

    expect(logger.info).toHaveBeenCalledWith(
      "Session consolidation pipeline started",
      expect.objectContaining({ sessionId, reason: "ended" }),
    );
  });

  it("does not emit the legacy 'Session stopped pipeline started' message", async () => {
    const sessionId = "ses_reason_legacy";
    const result: unknown = await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId, waitForCompletion: true },
    });
    await result;

    expect(logger.info).not.toHaveBeenCalledWith(
      "Session stopped pipeline started",
      expect.anything(),
    );
  });
});
