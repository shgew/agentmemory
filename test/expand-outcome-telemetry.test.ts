import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerSmartSearchFunction,
  resetFollowupStatsForTests,
  resetExpandStatsForTests,
  getExpandStats,
  flushPendingFollowups,
} from "../src/functions/smart-search.js";
import { registerRecentSearchesSweepFunction } from "../src/functions/recent-searches-sweep.js";
import { KV } from "../src/state/schema.js";
import type {
  HybridSearchResult,
  CompressedObservation,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
    getStore: () => store,
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : (idOrInput as any).payload;
      const fn = functions.get(id);
      if (!fn) {
        if (id === "mem::lesson-recall") return { success: true, lessons: [] };
        throw new Error(`No function: ${id}`);
      }
      const result = await fn(payload);
      // Followup + expand-outcome detection run off the critical path;
      // drain before returning so assertions see consistent state.
      if (id === "mem::smart-search") await flushPendingFollowups();
      return result;
    },
  } as any;
}

function makeHit(obsId: string, sessionId = "ses_1"): HybridSearchResult {
  return {
    observation: makeObs(obsId, sessionId),
    sessionId,
    combinedScore: 0.8,
  } as HybridSearchResult;
}

function makeObs(id: string, sessionId = "ses_1"): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: new Date().toISOString(),
    title: `obs ${id}`,
    narrative: "n",
    type: "pattern",
    facts: [],
    concepts: [],
    files: [],
    importance: 5,
  } as CompressedObservation;
}

describe("expand-outcome telemetry", () => {
  let sdk: any;
  let kv: ReturnType<typeof mockKV>;
  let searchResults: HybridSearchResult[];

  beforeEach(() => {
    resetFollowupStatsForTests();
    resetExpandStatsForTests();
    kv = mockKV();
    sdk = mockSdk();
    searchResults = [];
    registerSmartSearchFunction(sdk, kv as any, async () => searchResults);
    registerRecentSearchesSweepFunction(sdk, kv as any);
  });

  it("records that a prior search's result was expanded/read", async () => {
    await kv.set(KV.observations("ses_1"), "obs_a", makeObs("obs_a"));

    searchResults = [makeHit("obs_a"), makeHit("obs_b")];
    await sdk.trigger("mem::smart-search", {
      query: "auth flow",
      sessionId: "ses_1",
    });

    await sdk.trigger("mem::smart-search", {
      expandIds: [{ obsId: "obs_a", sessionId: "ses_1" }],
      sessionId: "ses_1",
    });

    const stats = getExpandStats();
    expect(stats.expandCallsWithSession).toBe(1);
    expect(stats.resultsExpandedFromPriorSearch).toBe(1);
    expect(stats.rate).toBeCloseTo(1);
  });

  it("does not record an expand of an obsId that was NOT in a prior search", async () => {
    await kv.set(KV.observations("ses_1"), "obs_z", makeObs("obs_z"));

    searchResults = [makeHit("obs_a"), makeHit("obs_b")];
    await sdk.trigger("mem::smart-search", {
      query: "auth flow",
      sessionId: "ses_1",
    });

    await sdk.trigger("mem::smart-search", {
      expandIds: [{ obsId: "obs_z", sessionId: "ses_1" }],
      sessionId: "ses_1",
    });

    const stats = getExpandStats();
    expect(stats.expandCallsWithSession).toBe(1);
    expect(stats.resultsExpandedFromPriorSearch).toBe(0);
    expect(stats.rate).toBe(0);
  });

  it("expand still returns results and never throws when there is no prior search row (best-effort)", async () => {
    await kv.set(KV.observations("ses_1"), "obs_a", makeObs("obs_a"));

    const res = (await sdk.trigger("mem::smart-search", {
      expandIds: [{ obsId: "obs_a", sessionId: "ses_1" }],
      sessionId: "ses_1",
    })) as { mode: string; results: Array<{ obsId: string }> };

    expect(res.mode).toBe("expanded");
    expect(res.results.map((r) => r.obsId)).toContain("obs_a");
    const stats = getExpandStats();
    expect(stats.expandCallsWithSession).toBe(1);
    expect(stats.resultsExpandedFromPriorSearch).toBe(0);
  });

  it("skips expand telemetry for viewer-originated calls", async () => {
    await kv.set(KV.observations("ses_1"), "obs_a", makeObs("obs_a"));
    searchResults = [makeHit("obs_a")];
    await sdk.trigger("mem::smart-search", {
      query: "auth flow",
      sessionId: "ses_1",
    });
    await sdk.trigger("mem::smart-search", {
      expandIds: [{ obsId: "obs_a", sessionId: "ses_1" }],
      sessionId: "ses_1",
      source: "viewer",
    });
    expect(getExpandStats().expandCallsWithSession).toBe(0);
  });

  it("diagnostic readback exposes the expand-outcome fields", async () => {
    await kv.set(KV.observations("ses_1"), "obs_a", makeObs("obs_a"));
    searchResults = [makeHit("obs_a")];
    await sdk.trigger("mem::smart-search", {
      query: "auth flow",
      sessionId: "ses_1",
    });
    await sdk.trigger("mem::smart-search", {
      expandIds: [{ obsId: "obs_a", sessionId: "ses_1" }],
      sessionId: "ses_1",
    });

    const stats = (await sdk.trigger(
      "mem::diagnostic::followup-stats",
      {},
    )) as Record<string, unknown>;

    expect(stats.expandCallsWithSession).toBe(1);
    expect(stats.resultsExpandedFromPriorSearch).toBe(1);
    expect(typeof stats.expandRate).toBe("number");
  });
});
