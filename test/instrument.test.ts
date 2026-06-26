import { describe, expect, it } from "vitest";
import { instrumentFunctionMetrics } from "../src/eval/instrument.js";
import { MetricsStore } from "../src/eval/metrics-store.js";
import type { StateKV } from "../src/state/kv.js";
import type { ISdk, RemoteFunctionHandler } from "iii-sdk";

function makeKv(): StateKV {
  const store = new Map<string, Map<string, unknown>>();
  return {
    async get(scope: string, key: string) {
      return store.get(scope)?.get(key) ?? null;
    },
    async set(scope: string, key: string, value: unknown) {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    async delete(scope: string, key: string) {
      store.get(scope)?.delete(key);
    },
    async list(scope: string) {
      return Array.from(store.get(scope)?.values() ?? []);
    },
    async update() {
      throw new Error("not used");
    },
  } as unknown as StateKV;
}

function makeSdk(): {
  sdk: ISdk;
  handlers: Map<string, RemoteFunctionHandler>;
} {
  const handlers = new Map<string, RemoteFunctionHandler>();
  const sdk = {
    registerFunction(functionId: string, handler: unknown) {
      if (typeof handler === "function") {
        handlers.set(functionId, handler as RemoteFunctionHandler);
      }
      return { functionId } as unknown;
    },
  } as unknown as ISdk;
  return { sdk, handlers };
}

// record() is fire-and-forget inside the wrapper; cross a macrotask boundary so
// the in-memory KV writes settle before we assert.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("instrumentFunctionMetrics", () => {
  it("records a successful mem:: call with latency and success", async () => {
    const ms = new MetricsStore(makeKv());
    const { sdk, handlers } = makeSdk();
    instrumentFunctionMetrics(sdk, ms);

    sdk.registerFunction("mem::frontier", async () => ({
      success: true,
      actions: [],
    }));
    await handlers.get("mem::frontier")!({});
    await flush();

    const m = await ms.get("mem::frontier");
    expect(m?.totalCalls).toBe(1);
    expect(m?.successCount).toBe(1);
    expect(m?.failureCount).toBe(0);
    expect(m?.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("treats a returned { success: false } as a failure", async () => {
    const ms = new MetricsStore(makeKv());
    const { sdk, handlers } = makeSdk();
    instrumentFunctionMetrics(sdk, ms);

    sdk.registerFunction("mem::next", async () => ({
      success: false,
      error: "no_actions",
    }));
    await handlers.get("mem::next")!({});
    await flush();

    const m = await ms.get("mem::next");
    expect(m?.totalCalls).toBe(1);
    expect(m?.successCount).toBe(0);
    expect(m?.failureCount).toBe(1);
  });

  it("counts a result without a success field as success", async () => {
    const ms = new MetricsStore(makeKv());
    const { sdk, handlers } = makeSdk();
    instrumentFunctionMetrics(sdk, ms);

    sdk.registerFunction("mem::lesson-list", async () => [{ id: "a" }]);
    await handlers.get("mem::lesson-list")!({});
    await flush();

    const m = await ms.get("mem::lesson-list");
    expect(m?.successCount).toBe(1);
    expect(m?.failureCount).toBe(0);
  });

  it("records a thrown error as a failure and re-throws it", async () => {
    const ms = new MetricsStore(makeKv());
    const { sdk, handlers } = makeSdk();
    instrumentFunctionMetrics(sdk, ms);

    sdk.registerFunction("mem::observe", async () => {
      throw new Error("boom");
    });
    await expect(handlers.get("mem::observe")!({})).rejects.toThrow("boom");
    await flush();

    const m = await ms.get("mem::observe");
    expect(m?.totalCalls).toBe(1);
    expect(m?.failureCount).toBe(1);
    expect(m?.successCount).toBe(0);
  });

  it("picks up a quality score returned on the result", async () => {
    const ms = new MetricsStore(makeKv());
    const { sdk, handlers } = makeSdk();
    instrumentFunctionMetrics(sdk, ms);

    sdk.registerFunction("mem::reflect", async () => ({
      success: true,
      qualityScore: 73,
    }));
    await handlers.get("mem::reflect")!({});
    await flush();

    const m = await ms.get("mem::reflect");
    expect(m?.avgQualityScore).toBe(73);
  });

  it("does not track non-mem:: functions", async () => {
    const ms = new MetricsStore(makeKv());
    const { sdk, handlers } = makeSdk();
    instrumentFunctionMetrics(sdk, ms);

    sdk.registerFunction("api::health", async () => ({ success: true }));
    await handlers.get("api::health")!({});
    await flush();

    expect(await ms.get("api::health")).toBeNull();
    expect(await ms.getAll()).toEqual([]);
  });

  it("does not double-count the self-recording mem::summarize / mem::compress", async () => {
    const ms = new MetricsStore(makeKv());
    const { sdk, handlers } = makeSdk();
    instrumentFunctionMetrics(sdk, ms);

    // Stub handlers that do NOT self-record (the real ones do). The wrapper
    // must leave them alone so production calls are counted exactly once.
    sdk.registerFunction("mem::summarize", async () => ({ success: true }));
    sdk.registerFunction("mem::compress", async () => ({ success: true }));
    await handlers.get("mem::summarize")!({});
    await handlers.get("mem::compress")!({});
    await flush();

    expect(await ms.get("mem::summarize")).toBeNull();
    expect(await ms.get("mem::compress")).toBeNull();
  });

  it("registers an HttpInvocationConfig handler untouched", async () => {
    const ms = new MetricsStore(makeKv());
    const { sdk, handlers } = makeSdk();
    instrumentFunctionMetrics(sdk, ms);

    // Non-function handler (HTTP invocation config object) must pass through.
    sdk.registerFunction(
      "mem::http-shaped",
      { url: "http://example" } as unknown as RemoteFunctionHandler,
    );
    expect(handlers.has("mem::http-shaped")).toBe(false);
    expect(await ms.getAll()).toEqual([]);
  });
});
