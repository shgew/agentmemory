import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

const memoryTarget = (id: string) => ({ id, scope: "memory" }) as const;

async function seedMemory(kv: ReturnType<typeof mockKV>, id: string) {
  await kv.set("mem:memories", id, { id });
}

describe("access-tracker", () => {
  it("records only while the described durable owner exists", async () => {
    const { recordOwnedAccess, getAccessLog } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    const target = { id: "mem_owned", scope: "memory" } as const;

    await recordOwnedAccess(kv as never, target, 1_000);
    await kv.set("mem:memories", target.id, { id: target.id });
    await recordOwnedAccess(kv as never, target, 2_000);
    await kv.delete("mem:memories", target.id);
    await recordOwnedAccess(kv as never, target, 3_000);

    const log = await getAccessLog(kv as never, target.id);
    expect(log.count).toBe(1);
    expect(log.recent).toEqual([2_000]);
  });

  it("validates observations in the described session without listing sessions", async () => {
    const { recordOwnedAccess, getAccessLog } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    kv.list = vi.fn(async () => {
      throw new Error("global scans are forbidden");
    }) as never;
    await kv.set("mem:obs:ses_owner", "obs_owned", { id: "obs_owned" });

    await recordOwnedAccess(
      kv as never,
      { id: "obs_owned", scope: "observation", sessionId: "ses_wrong" },
      1_000,
    );
    await recordOwnedAccess(
      kv as never,
      { id: "obs_owned", scope: "observation", sessionId: "ses_owner" },
      2_000,
    );

    expect((await getAccessLog(kv as never, "obs_owned")).recent).toEqual([
      2_000,
    ]);
    expect(kv.list).not.toHaveBeenCalled();
  });

  it("getAccessLog returns empty log for unknown id", async () => {
    const { getAccessLog } = await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    const log = await getAccessLog(kv as never, "mem_xyz");
    expect(log).toEqual({
      memoryId: "mem_xyz",
      count: 0,
      lastAt: "",
      recent: [],
    });
  });

  it("recordOwnedAccess increments count and lastAt", async () => {
    const { recordOwnedAccess, getAccessLog } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_a");
    await recordOwnedAccess(kv as never, memoryTarget("mem_a"), 1_000_000);
    await recordOwnedAccess(kv as never, memoryTarget("mem_a"), 2_000_000);
    await recordOwnedAccess(kv as never, memoryTarget("mem_a"), 3_000_000);

    const log = await getAccessLog(kv as never, "mem_a");
    expect(log.count).toBe(3);
    expect(log.recent).toEqual([1_000_000, 2_000_000, 3_000_000]);
    expect(log.lastAt).toBe(new Date(3_000_000).toISOString());
  });

  it("recent[] is bounded to last 20 entries", async () => {
    const { recordOwnedAccess, getAccessLog } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_b");
    for (let i = 1; i <= 50; i++) {
      await recordOwnedAccess(kv as never, memoryTarget("mem_b"), i * 1000);
    }
    const log = await getAccessLog(kv as never, "mem_b");
    expect(log.count).toBe(50);
    expect(log.recent.length).toBe(20);
    // Should be the LAST 20: 31_000..50_000
    expect(log.recent[0]).toBe(31_000);
    expect(log.recent[19]).toBe(50_000);
  });

  it("recordOwnedAccessBatch deduplicates and writes once per id", async () => {
    const { recordOwnedAccessBatch, getAccessLog } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    for (const id of ["mem_a", "mem_b", "mem_c"]) await seedMemory(kv, id);
    await recordOwnedAccessBatch(
      kv as never,
      ["mem_a", "mem_b", "mem_a", "mem_b", "mem_c"].map(memoryTarget),
      5_000_000,
    );
    expect((await getAccessLog(kv as never, "mem_a")).count).toBe(1);
    expect((await getAccessLog(kv as never, "mem_b")).count).toBe(1);
    expect((await getAccessLog(kv as never, "mem_c")).count).toBe(1);
  });

  it("recordOwnedAccess swallows kv.set errors", async () => {
    const { recordOwnedAccess } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_a");
    kv.set = (async () => {
      throw new Error("boom");
    }) as never;
    await expect(
      recordOwnedAccess(kv as never, memoryTarget("mem_a")),
    ).resolves.toBeUndefined();
  });

  it("concurrent owned access calls do not lose increments", async () => {
    const { recordOwnedAccess, getAccessLog } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_race");
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        recordOwnedAccess(kv as never, memoryTarget("mem_race"), i * 100),
      ),
    );
    const log = await getAccessLog(kv as never, "mem_race");
    expect(log.count).toBe(25);
  });

  it("one failing owned access does not block siblings", async () => {
    const { recordOwnedAccessBatch, getAccessLog } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    for (const id of ["mem_slow", "mem_fast_a", "mem_fast_b"]) {
      await seedMemory(kv, id);
    }
    const realSet = kv.set.bind(kv);
    kv.set = (async (scope: string, key: string, val: unknown) => {
      if (key === "mem_slow") throw new Error("write failed");
      return realSet(scope, key, val);
    }) as never;

    await recordOwnedAccessBatch(
      kv as never,
      ["mem_slow", "mem_fast_a", "mem_fast_b"].map(memoryTarget),
      1_000_000,
    );
    expect((await getAccessLog(kv as never, "mem_fast_a")).count).toBe(1);
    expect((await getAccessLog(kv as never, "mem_fast_b")).count).toBe(1);
    expect((await getAccessLog(kv as never, "mem_slow")).count).toBe(0);
  });

  it("ignores empty / falsy memory ids", async () => {
    const { recordOwnedAccess, recordOwnedAccessBatch } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_x");
    await recordOwnedAccess(kv as never, memoryTarget(""));
    await recordOwnedAccessBatch(
      kv as never,
      ["", "mem_x", ""].map(memoryTarget),
    );
    expect(kv.store.get("mem:access")?.has("")).toBeFalsy();
    expect(kv.store.get("mem:access")?.get("mem_x")).toBeTruthy();
  });

  it("deleteAccessLog removes the target entry and leaves siblings intact", async () => {
    const { recordOwnedAccess, deleteAccessLog, getAccessLog } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_a");
    await seedMemory(kv, "mem_b");
    await recordOwnedAccess(kv as never, memoryTarget("mem_a"));
    await recordOwnedAccess(kv as never, memoryTarget("mem_b"));

    await deleteAccessLog(kv as never, "mem_a");

    expect(kv.store.get("mem:access")?.has("mem_a")).toBe(false);
    expect((await getAccessLog(kv as never, "mem_b")).count).toBe(1);
  });

  it("does not recreate an access log queued behind deletion", async () => {
    const { deleteAccessLog, recordOwnedAccess } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_deleted");
    await recordOwnedAccess(kv as never, memoryTarget("mem_deleted"));
    const deleteEntry = kv.delete.bind(kv);
    let releaseDelete: () => void = () => {};
    let markDeleteStarted: () => void = () => {};
    const deleteBlocked = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    kv.delete = (async (scope: string, key: string) => {
      if (scope === "mem:access" && key === "mem_deleted") {
        markDeleteStarted();
        await deleteBlocked;
      }
      return deleteEntry(scope, key);
    }) as never;

    await kv.delete("mem:memories", "mem_deleted");
    const deletion = deleteAccessLog(kv as never, "mem_deleted");
    await deleteStarted;
    const queuedAccess = recordOwnedAccess(
      kv as never,
      memoryTarget("mem_deleted"),
    );
    releaseDelete();
    await Promise.all([deletion, queuedAccess]);

    expect(kv.store.get("mem:access")?.has("mem_deleted")).toBe(false);
  });

  it("blocks delayed access recorded after deletion", async () => {
    const { deleteAccessLog, recordOwnedAccess } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_delayed");
    await recordOwnedAccess(kv as never, memoryTarget("mem_delayed"));

    await kv.delete("mem:memories", "mem_delayed");
    await deleteAccessLog(kv as never, "mem_delayed");
    await recordOwnedAccess(kv as never, memoryTarget("mem_delayed"));

    expect(kv.store.get("mem:access")?.has("mem_delayed")).toBe(false);
  });

  it("tracks an explicitly restored owner without a tombstone override", async () => {
    const { deleteAccessLog, recordOwnedAccess } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_restored");
    await kv.delete("mem:memories", "mem_restored");
    await deleteAccessLog(kv as never, "mem_restored");

    await seedMemory(kv, "mem_restored");
    await recordOwnedAccess(kv as never, memoryTarget("mem_restored"));

    expect(kv.store.get("mem:access")?.has("mem_restored")).toBe(true);
  });

  it("does not retain deletion state after access-log cleanup", async () => {
    const { deleteAccessLog, recordOwnedAccess } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_live");

    await deleteAccessLog(kv as never, "mem_live");
    await recordOwnedAccess(kv as never, memoryTarget("mem_live"));

    expect(kv.store.get("mem:access")?.has("mem_live")).toBe(true);
  });

  it("deleteAccessLog is a no-op for unknown ids and empty ids", async () => {
    const { deleteAccessLog, recordOwnedAccess } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    await seedMemory(kv, "mem_keep");
    await recordOwnedAccess(kv as never, memoryTarget("mem_keep"));

    await deleteAccessLog(kv as never, "");
    await deleteAccessLog(kv as never, "mem_unknown");

    expect(kv.store.get("mem:access")?.has("mem_keep")).toBe(true);
  });

  it("deleteAccessLog reports kv.delete errors", async () => {
    const { deleteAccessLog } =
      await import("../src/functions/access-tracker.js");
    const kv = mockKV();
    kv.delete = (async () => {
      throw new Error("boom");
    }) as never;

    await expect(deleteAccessLog(kv as never, "mem_x")).rejects.toThrow("boom");
  });
});

describe("normalizeAccessLog", () => {
  it("returns a well-formed empty log for nullish / non-object input", async () => {
    const { normalizeAccessLog } =
      await import("../src/functions/access-tracker.js");
    const log = normalizeAccessLog(null);
    expect(log).toEqual({
      memoryId: "",
      count: 0,
      lastAt: "",
      recent: [],
    });
    expect(normalizeAccessLog(undefined).count).toBe(0);
    expect(normalizeAccessLog("garbage").count).toBe(0);
  });

  it("coerces count to a non-negative integer", async () => {
    const { normalizeAccessLog } =
      await import("../src/functions/access-tracker.js");
    expect(normalizeAccessLog({ count: -5 }).count).toBe(0);
    expect(normalizeAccessLog({ count: 3.7 }).count).toBe(3);
    expect(normalizeAccessLog({ count: NaN }).count).toBe(0);
    expect(normalizeAccessLog({ count: "123" }).count).toBe(0);
  });

  it("preserves large lifetime counts (NOT capped at ring buffer size)", async () => {
    const { normalizeAccessLog } =
      await import("../src/functions/access-tracker.js");
    const log = normalizeAccessLog({ memoryId: "m", count: 500, recent: [1] });
    expect(log.count).toBe(500);
  });

  it("truncates recent[] to the last 20 entries and drops non-finite values", async () => {
    const { normalizeAccessLog } =
      await import("../src/functions/access-tracker.js");
    const input = Array.from({ length: 40 }, (_, i) => i * 1000);
    const withGarbage = [...input, NaN, Infinity, "bad" as unknown as number];
    const log = normalizeAccessLog({ recent: withGarbage });
    expect(log.recent.length).toBe(20);
    expect(log.recent[0]).toBe(20_000);
    expect(log.recent[19]).toBe(39_000);
  });

  it("count is at least recent.length when count < recent.length", async () => {
    const { normalizeAccessLog } =
      await import("../src/functions/access-tracker.js");
    const log = normalizeAccessLog({
      count: 2,
      recent: [1, 2, 3, 4, 5],
    });
    expect(log.count).toBeGreaterThanOrEqual(5);
  });

  it("fills in memoryId only when field is a string", async () => {
    const { normalizeAccessLog } =
      await import("../src/functions/access-tracker.js");
    expect(normalizeAccessLog({ memoryId: "mem_x" }).memoryId).toBe("mem_x");
    expect(normalizeAccessLog({ memoryId: 42 }).memoryId).toBe("");
  });
});
