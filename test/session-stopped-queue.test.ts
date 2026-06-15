import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CompressedObservation } from "../src/types.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Handler = (payload: any) => unknown | Promise<unknown>;

const ORIGINAL_ENV = { ...process.env };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockSdk() {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ function_id: string; payload: unknown }> = [];
  return {
    calls,
    sdk: {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      registerTrigger: vi.fn(),
      trigger: async (input: { function_id: string; payload: unknown }) => {
        calls.push(input);
        const handler = handlers.get(input.function_id);
        if (!handler) throw new Error(`missing handler: ${input.function_id}`);
        return handler(input.payload);
      },
    },
  };
}

function mockKV(sessionId: string) {
  const observations: CompressedObservation[] = [
    {
      id: "obs_1",
      sessionId,
      timestamp: new Date().toISOString(),
      type: "decision",
      title: "Chose sqlite storage",
      facts: ["Use sqlite for local state"],
      narrative: "The session chose sqlite for local state.",
      concepts: ["sqlite"],
      files: ["src/state/kv.ts"],
      importance: 8,
    },
  ];
  return {
    list: async <T>(scope: string): Promise<T[]> =>
      scope === KV.observations(sessionId) ? (observations as T[]) : [],
  };
}

describe("event::session::stopped queue", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, GRAPH_EXTRACTION_ENABLED: "true" };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("queues stopped-session pipelines without blocking default callers", async () => {
    const { registerEventTriggers } = await import("../src/triggers/events.js");
    const { sdk } = mockSdk();
    const sessionId = "ses_async";
    const summarizeGate = deferred();
    let summarizeCompleted = false;

    registerEventTriggers(sdk as never, mockKV(sessionId) as never);
    sdk.registerFunction("mem::summarize", async () => {
      await summarizeGate.promise;
      summarizeCompleted = true;
      return { success: true };
    });
    sdk.registerFunction("mem::graph-extract", () => ({ success: true }));

    const result = await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId },
    });

    expect(result).toMatchObject({ queued: true, sessionId, queueDepth: 1 });
    expect(summarizeCompleted).toBe(false);

    summarizeGate.resolve();
    await Promise.resolve();
  });

  it("waits for its queued pipeline when waitForCompletion is true", async () => {
    const { registerEventTriggers } = await import("../src/triggers/events.js");
    const { sdk, calls } = mockSdk();
    const sessionId = "ses_sync";

    registerEventTriggers(sdk as never, mockKV(sessionId) as never);
    sdk.registerFunction("mem::summarize", async () => ({ success: true }));
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));

    const result = await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId, waitForCompletion: true },
    });

    expect(result).toMatchObject({ success: true });
    expect(calls.map((call) => call.function_id)).toEqual(
      expect.arrayContaining(["mem::summarize", "mem::graph-extract"]),
    );
    expect(
      calls.findIndex((call) => call.function_id === "mem::summarize"),
    ).toBeLessThan(
      calls.findIndex((call) => call.function_id === "mem::graph-extract"),
    );
  });
});
