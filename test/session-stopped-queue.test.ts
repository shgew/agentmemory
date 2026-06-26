import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CompressedObservation } from "../src/types.js";

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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mockSdk() {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ function_id: string; payload: any }> = [];
  return {
    calls,
    sdk: {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      registerTrigger: vi.fn(),
      trigger: async (input: { function_id: string; payload: any }) => {
        calls.push(input);
        const handler = handlers.get(input.function_id);
        if (!handler) throw new Error(`missing handler: ${input.function_id}`);
        return handler(input.payload);
      },
    },
  };
}

function mockKV() {
  const observations: CompressedObservation[] = [
    {
      id: "obs_1",
      sessionId: "s",
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
    list: async <T>(): Promise<T[]> => observations as unknown as T[],
  };
}

describe("event::session::stopped consolidation pool", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, GRAPH_EXTRACTION_ENABLED: "true" };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("queues a single pipeline without blocking default callers", async () => {
    const { registerEventTriggers } = await import("../src/triggers/events.js");
    const { sdk } = mockSdk();
    const summarizeGate = deferred();
    let summarizeCompleted = false;

    registerEventTriggers(sdk as never, mockKV() as never);
    sdk.registerFunction("mem::summarize", async () => {
      await summarizeGate.promise;
      summarizeCompleted = true;
      return { success: true };
    });
    sdk.registerFunction("mem::graph-extract", () => ({ success: true }));

    const result = await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_async" },
    });

    expect(result).toMatchObject({
      queued: true,
      sessionId: "ses_async",
      queueDepth: 1,
    });
    expect(summarizeCompleted).toBe(false);

    summarizeGate.resolve();
    await flush();
  });

  it("waits for its queued pipeline when waitForCompletion is true", async () => {
    const { registerEventTriggers } = await import("../src/triggers/events.js");
    const { sdk, calls } = mockSdk();

    registerEventTriggers(sdk as never, mockKV() as never);
    sdk.registerFunction("mem::summarize", async () => ({ success: true }));
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));

    const result = await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_sync", waitForCompletion: true },
    });

    expect(result).toMatchObject({ success: true });
    expect(calls.map((call) => call.function_id)).toEqual(
      expect.arrayContaining(["mem::summarize", "mem::graph-extract"]),
    );
  });

  it("runs graph-extract and rejects when summarize hard-fails", async () => {
    const { registerEventTriggers } = await import("../src/triggers/events.js");
    const { sdk, calls } = mockSdk();

    registerEventTriggers(sdk as never, mockKV() as never);
    sdk.registerFunction("mem::summarize", async () => ({
      success: false,
      error: "parse_failed",
    }));
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));

    await expect(
      sdk.trigger({
        function_id: "event::session::stopped",
        payload: { sessionId: "ses_failfast", waitForCompletion: true },
      }),
    ).rejects.toThrow(/parse_failed/);

    expect(calls.map((c) => c.function_id)).toContain("mem::graph-extract");
  });

  it("runs up to CONSOLIDATION_CONCURRENCY sessions in parallel", async () => {
    process.env.CONSOLIDATION_CONCURRENCY = "2";
    const { registerEventTriggers } = await import("../src/triggers/events.js");
    const { sdk } = mockSdk();
    const gates = new Map([
      ["s1", deferred()],
      ["s2", deferred()],
      ["s3", deferred()],
    ]);
    const entered: string[] = [];

    registerEventTriggers(sdk as never, mockKV() as never);
    sdk.registerFunction("mem::summarize", async (p: { sessionId: string }) => {
      entered.push(p.sessionId);
      await gates.get(p.sessionId)!.promise;
      return { success: true };
    });
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));

    const d1 = sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "s1", waitForCompletion: true },
    });
    const d2 = sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "s2", waitForCompletion: true },
    });
    const d3 = sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "s3", waitForCompletion: true },
    });

    await flush();
    expect([...entered].sort()).toEqual(["s1", "s2"]);
    expect(entered).not.toContain("s3");

    gates.get("s1")!.resolve();
    await flush();
    expect(entered).toContain("s3");

    gates.get("s2")!.resolve();
    gates.get("s3")!.resolve();
    await Promise.all([d1, d2, d3]);
  });

  it("serializes two events for the same session even with free pool slots", async () => {
    process.env.CONSOLIDATION_CONCURRENCY = "2";
    const { registerEventTriggers } = await import("../src/triggers/events.js");
    const { sdk } = mockSdk();
    const dupGates = [deferred(), deferred()];
    const entered: string[] = [];
    let dupCall = 0;

    registerEventTriggers(sdk as never, mockKV() as never);
    sdk.registerFunction("mem::summarize", async () => {
      const idx = dupCall++;
      entered.push(`dup#${idx}`);
      await dupGates[idx]!.promise;
      return { success: true };
    });
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));

    const d1 = sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "dup", waitForCompletion: true },
    });
    const d2 = sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "dup", waitForCompletion: true },
    });

    await flush();
    expect(entered).toEqual(["dup#0"]);

    dupGates[0]!.resolve();
    await flush();
    expect(entered).toEqual(["dup#0", "dup#1"]);

    dupGates[1]!.resolve();
    await Promise.all([d1, d2]);
  });
});


describe("event::session::stopped fire-and-forget failure", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, GRAPH_EXTRACTION_ENABLED: "true" };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("does not surface an unhandled rejection when a fire-and-forget pipeline fails", async () => {
    const { registerEventTriggers } = await import("../src/triggers/events.js");
    const { sdk } = mockSdk();
    registerEventTriggers(sdk as never, mockKV() as never);
    sdk.registerFunction("mem::summarize", async () => {
      throw new Error("boom_fire_and_forget");
    });
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const res = await sdk.trigger({
        function_id: "event::session::stopped",
        payload: { sessionId: "ff" },
      });
      expect(res).toMatchObject({ queued: true });
      await flush();
      await flush();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });
});