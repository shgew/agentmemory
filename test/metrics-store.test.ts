import { describe, expect, it } from "vitest";
import { MetricsStore } from "../src/eval/metrics-store.js";
import type { StateKV } from "../src/state/kv.js";

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

describe("MetricsStore.clear", () => {
  it("wipes both the in-memory cache and the persisted KV scope", async () => {
    const ms = new MetricsStore(makeKv());
    await ms.record("mem::summarize", 100, false, 40);
    await ms.record("mem::compress", 50, true, 90);
    expect((await ms.getAll()).length).toBe(2);

    const cleared = await ms.clear();
    expect(cleared).toBe(2);
    expect(await ms.getAll()).toEqual([]);
  });

  it("starts from zero after clear (proves the cache was dropped, not just KV)", async () => {
    const ms = new MetricsStore(makeKv());
    await ms.record("mem::summarize", 100, false);
    await ms.record("mem::summarize", 100, false);
    expect((await ms.get("mem::summarize"))?.failureCount).toBe(2);

    await ms.clear();

    await ms.record("mem::summarize", 10, true);
    const after = await ms.get("mem::summarize");
    expect(after?.totalCalls).toBe(1);
    expect(after?.failureCount).toBe(0);
    expect(after?.successCount).toBe(1);
  });

  it("is a no-op that returns 0 when there are no metrics", async () => {
    const ms = new MetricsStore(makeKv());
    expect(await ms.clear()).toBe(0);
    expect(await ms.getAll()).toEqual([]);
  });
});
