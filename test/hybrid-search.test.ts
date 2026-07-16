/// <reference types="node" />

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  HybridSearch,
  type HybridSearchTimings,
} from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import type {
  CompressedObservation,
  GraphNode,
  GraphSnapshot,
  HybridSearchResult,
} from "../src/types.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    sourceType: "test",
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
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

describe("HybridSearch", () => {
  let bm25: SearchIndex;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    bm25 = new SearchIndex();
    kv = mockKV();
  });

  it("returns BM25-only results when no vector index is provided", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("obs_1");
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].bm25Score).toBeGreaterThan(0);
  });

  it("records vector, keyword, and RRF timings without changing results", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);
    const timings: HybridSearchTimings = {
      vectorSearchMs: 0,
      bm25SearchMs: 0,
      rankingRrfFusionMs: 0,
    };

    const results = await new HybridSearch(bm25, null, null, kv as never).search(
      "auth",
      20,
      timings,
    );

    expect(results.map((result) => result.observation.id)).toEqual(["obs_1"]);
    expect(timings).toEqual({
      vectorSearchMs: expect.any(Number),
      bm25SearchMs: expect.any(Number),
      rankingRrfFusionMs: expect.any(Number),
    });
  });

  it("returns empty results for no-match query", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("database");
    expect(results).toEqual([]);
  });

  it("combinedScore is derived from bm25Score when no vector index", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results[0].combinedScore).toBeGreaterThan(0);
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].graphScore).toBe(0);
  });

  it("results are sorted by combinedScore descending", async () => {
    const obs1 = makeObs({
      id: "obs_1",
      sessionId: "ses_1",
      title: "auth handler",
      narrative: "auth auth auth module",
      concepts: ["auth"],
    });
    const obs2 = makeObs({
      id: "obs_2",
      sessionId: "ses_1",
      title: "database setup",
      narrative: "auth connection config",
      concepts: ["database"],
    });
    bm25.add(obs1);
    bm25.add(obs2);
    await kv.set("mem:obs:ses_1", "obs_1", obs1);
    await kv.set("mem:obs:ses_1", "obs_2", obs2);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(2);
    expect(results[0].combinedScore).toBeGreaterThanOrEqual(
      results[1].combinedScore,
    );
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      const obs = makeObs({
        id: `obs_${i}`,
        sessionId: "ses_1",
        title: `auth feature ${i}`,
      });
      bm25.add(obs);
      await kv.set("mem:obs:ses_1", `obs_${i}`, obs);
    }

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth", 3);
    expect(results.length).toBe(3);
  });

  it("skips observations not found in KV", async () => {
    const obs = makeObs({ id: "obs_missing", sessionId: "ses_1" });
    bm25.add(obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");
    expect(results).toEqual([]);
  });

  it("falls back to KV.memories when an indexed entry is a saved memory (#265)", async () => {
    // mem::remember writes to KV.memories under the synthetic sessionId
    // "memory" — the BM25 index sees that synthetic sessionId, but
    // KV.observations("memory") never has anything.
    const indexable = makeObs({
      id: "mem_abc",
      sessionId: "memory",
      title: "Test memory for search",
      narrative: "Test memory for search",
      concepts: ["test", "search"],
    });
    bm25.add(indexable);

    const memory = {
      id: "mem_abc",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      type: "fact",
      title: "Test memory for search",
      content: "Test memory for search",
      concepts: ["test", "search"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_abc", memory);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("test memory search");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("mem_abc");
    expect(results[0].observation.narrative).toBe("Test memory for search");
    expect(results[0].observation.concepts).toEqual(["test", "search"]);
  });

  it("enriches a graph-only candidate whose retrieval result has no sessionId", async () => {
    const anchor = makeObs({
      id: "obs_anchor",
      sessionId: "ses_anchor",
      title: "Project Asterion launch",
      narrative: "Synthetic graph anchor",
      concepts: ["asterion"],
    });
    const graphOnly = makeObs({
      id: "obs_graph_only",
      sessionId: "ses_target",
      title: "Decorrelated jitter stabilized queue workers",
      narrative: "Queue starvation stopped after retry timing changed",
      concepts: ["retry-jitter", "queue-starvation"],
    });
    bm25.add(anchor);
    bm25.add(graphOnly);
    await kv.set("mem:obs:ses_anchor", anchor.id, anchor);
    await kv.set("mem:obs:ses_target", graphOnly.id, graphOnly);

    const snapshot: GraphSnapshot = {
      version: 1,
      topNodes: [
        {
          id: "gn_anchor",
          type: "project",
          name: "Asterion",
          properties: {},
          sourceObservationIds: [anchor.id],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "gn_target",
          type: "concept",
          name: "Queue mitigation",
          properties: {},
          sourceObservationIds: [graphOnly.id],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      topEdges: [
        {
          id: "ge_link",
          type: "related_to",
          sourceNodeId: "gn_anchor",
          targetNodeId: "gn_target",
          weight: 1,
          sourceObservationIds: [anchor.id, graphOnly.id],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      topDegrees: { gn_anchor: 1, gn_target: 1 },
      stats: {
        totalNodes: 2,
        totalEdges: 1,
        nodesByType: { project: 1, concept: 1 },
        edgesByType: { related_to: 1 },
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      dirty: false,
    };
    await kv.set("mem:graph:snapshot", "current", snapshot);

    const hybrid = new HybridSearch(
      bm25,
      null,
      null,
      kv as never,
      0.4,
      0,
      0.3,
      false,
      true,
    );
    const results = await hybrid.search("Project Asterion", 10);

    const recovered = results.find(
      (result) => result.observation.id === graphOnly.id,
    );
    expect(recovered?.sessionId).toBe(graphOnly.sessionId);
    expect(recovered?.graphScore).toBeGreaterThan(0);
  });
});

// Deliverable #2: GRAPH_SEARCH_ENABLED is a TRUE bypass of graph consumption
// in hybrid search (distinct from graphWeight=0, which still traverses the
// snapshot before multiplying the contribution out). When the flag is
// unset/false the snapshot must never be read, GraphRetrieval must never run,
// and no graph stream may enter RRF fusion.
describe("HybridSearch graph consumption kill switch (GRAPH_SEARCH_ENABLED)", () => {
  const originalFlag = process.env.GRAPH_SEARCH_ENABLED;
  let bm25: SearchIndex;

  function graphSnapshotWithReactNode(): GraphSnapshot {
    const node: GraphNode = {
      id: "gn_react",
      type: "library",
      name: "React",
      properties: {},
      sourceObservationIds: ["obs_1"],
      createdAt: new Date().toISOString(),
    };
    return {
      version: 1,
      topNodes: [node],
      topEdges: [],
      topDegrees: { [node.id]: 0 },
      stats: {
        totalNodes: 1,
        totalEdges: 0,
        nodesByType: { library: 1 },
        edgesByType: {},
      },
      updatedAt: new Date().toISOString(),
      dirty: false,
    };
  }

  // Seeds the observation + (optionally) a graph snapshot and counts reads of
  // the snapshot scope, so a test can prove the snapshot loader was never hit.
  function mockKVWithSnapshot(
    obs: CompressedObservation,
    snapshot: GraphSnapshot | null,
  ) {
    const store = new Map<string, Map<string, unknown>>();
    store.set(`mem:obs:${obs.sessionId}`, new Map([[obs.id, obs]]));
    if (snapshot) {
      store.set("mem:graph:snapshot", new Map([["current", snapshot]]));
    }
    let snapshotReads = 0;
    const kv = {
      get: async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === "mem:graph:snapshot") snapshotReads++;
        return (store.get(scope)?.get(key) as T) ?? null;
      },
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(key, data);
        return data;
      },
      delete: async (scope: string, key: string): Promise<void> => {
        store.get(scope)?.delete(key);
      },
      list: async <T>(scope: string): Promise<T[]> => {
        const entries = store.get(scope);
        return entries ? (Array.from(entries.values()) as T[]) : [];
      },
    };
    return { kv, snapshotReads: () => snapshotReads };
  }

  const project = (rs: HybridSearchResult[]) =>
    rs.map((r) => ({
      id: r.observation.id,
      bm25Score: r.bm25Score,
      vectorScore: r.vectorScore,
      graphScore: r.graphScore,
      combinedScore: r.combinedScore,
    }));

  beforeEach(() => {
    bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", sessionId: "ses_1" }));
    delete process.env.GRAPH_SEARCH_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalFlag === undefined) delete process.env.GRAPH_SEARCH_ENABLED;
    else process.env.GRAPH_SEARCH_ENABLED = originalFlag;
  });

  it("never loads the snapshot or runs GraphRetrieval when the flag is unset/false", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    const { kv, snapshotReads } = mockKVWithSnapshot(
      obs,
      graphSnapshotWithReactNode(),
    );
    const searchSpy = vi.spyOn(GraphRetrieval.prototype, "searchByEntities");
    const expandSpy = vi.spyOn(GraphRetrieval.prototype, "expandFromChunks");

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("React auth");

    // The snapshot's "React" node points at obs_1; if graph consumption ran it
    // would score obs_1 via the graph stream. The flag-off path must bypass it.
    expect(searchSpy).not.toHaveBeenCalled();
    expect(expandSpy).not.toHaveBeenCalled();
    expect(snapshotReads()).toBe(0);
    expect(results[0].observation.id).toBe("obs_1");
    expect(results[0].graphScore).toBe(0);
  });

  it("returns results identical to a BM25+vector-only baseline when the flag is off", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    // subject: snapshot present that WOULD contribute a graph score.
    const subjectKv = mockKVWithSnapshot(
      obs,
      graphSnapshotWithReactNode(),
    ).kv;
    // baseline: no snapshot at all -> BM25 (+vector, none here) only.
    const baselineKv = mockKVWithSnapshot(obs, null).kv;

    const subject = await new HybridSearch(
      bm25,
      null,
      null,
      subjectKv as never,
    ).search("React auth");
    const baseline = await new HybridSearch(
      bm25,
      null,
      null,
      baselineKv as never,
    ).search("React auth");

    expect(project(subject)).toEqual(project(baseline));
  });

  it("consults the graph when GRAPH_SEARCH_ENABLED=true (existing behavior preserved)", async () => {
    process.env.GRAPH_SEARCH_ENABLED = "true";
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    const { kv, snapshotReads } = mockKVWithSnapshot(
      obs,
      graphSnapshotWithReactNode(),
    );
    const searchSpy = vi.spyOn(GraphRetrieval.prototype, "searchByEntities");

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("React auth");

    expect(searchSpy).toHaveBeenCalled();
    expect(snapshotReads()).toBeGreaterThan(0);
    const obs1 = results.find((r) => r.observation.id === "obs_1");
    expect(obs1).toBeDefined();
    expect(obs1!.graphScore).toBeGreaterThan(0);
  });

  it("does not crash and serves a no-graph path when the snapshot is stale/missing (STALE STATE)", async () => {
    process.env.GRAPH_SEARCH_ENABLED = "true";
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    // Flag flipped on but no snapshot present yet (stale/missing state).
    const { kv } = mockKVWithSnapshot(obs, null);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("React auth");

    expect(results[0].observation.id).toBe("obs_1");
    expect(results[0].graphScore).toBe(0);
  });
});
