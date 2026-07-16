import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  applyDegreeDelta,
  recordGraphTombstone,
  registerGraphFunction,
} from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphEdge, GraphSnapshot } from "../src/types.js";

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
    list: async <T>(scope: string): Promise<T[]> => {
      const e = store.get(scope);
      return e ? (Array.from(e.values()) as T[]) : [];
    },
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
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };

function node(id: string, type = "concept", name = id): GraphNode {
  return {
    id,
    type: type as GraphNode["type"],
    name,
    properties: {},
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

function edge(id: string, src: string, tgt: string, type = "related_to"): GraphEdge {
  return {
    id,
    type: type as GraphEdge["type"],
    sourceNodeId: src,
    targetNodeId: tgt,
    weight: 1,
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

const nameKey = (type: string, name: string) => `${type}|${name}`;
const edgeKey = (src: string, tgt: string, type: string) => `${src}|${tgt}|${type}`;

function setup() {
  const kv = mockKV();
  const sdk = mockSdk();
  registerGraphFunction(sdk as never, kv as never, provider as never);
  return { kv, sdk };
}

describe("mem::graph-vacuum", () => {
  it("deletes a tombstoned node + its degree + name-index entry, then clears the tombstone", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.graphNodes, "gn_1", node("gn_1", "concept", "foo"));
    await kv.set(KV.graphNameIndex, nameKey("concept", "foo"), "gn_1");
    await kv.set(KV.graphNodeDegree, "gn_1", 3);
    await kv.set(KV.graphTombstones, "gn_1", {
      id: "gn_1",
      kind: "node",
      reason: "cascade",
      indexKey: nameKey("concept", "foo"),
      tombstonedAt: "2026-04-01T00:00:00Z",
    });

    const res = (await sdk.trigger("mem::graph-vacuum", {})) as {
      deletedNodes: number;
      remaining: number;
    };

    expect(res.deletedNodes).toBe(1);
    expect(res.remaining).toBe(0);
    expect(await kv.get(KV.graphNodes, "gn_1")).toBeNull();
    expect(await kv.get(KV.graphNodeDegree, "gn_1")).toBeNull();
    expect(await kv.get(KV.graphNameIndex, nameKey("concept", "foo"))).toBeNull();
    expect(await kv.get(KV.graphTombstones, "gn_1")).toBeNull();
  });

  it("preserves the name-index entry when it was repointed to a live node (verify-then-delete)", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.graphNodes, "gn_old", node("gn_old", "concept", "foo"));
    // A newer extract already recreated "concept|foo" and repointed the index.
    await kv.set(KV.graphNameIndex, nameKey("concept", "foo"), "gn_new");
    await kv.set(KV.graphTombstones, "gn_old", {
      id: "gn_old",
      kind: "node",
      reason: "orphan",
      indexKey: nameKey("concept", "foo"),
      tombstonedAt: "2026-04-01T00:00:00Z",
    });

    await sdk.trigger("mem::graph-vacuum", {});

    expect(await kv.get(KV.graphNodes, "gn_old")).toBeNull();
    // The live node's dedup entry MUST survive.
    expect(await kv.get(KV.graphNameIndex, nameKey("concept", "foo"))).toBe("gn_new");
    expect(await kv.get(KV.graphTombstones, "gn_old")).toBeNull();
  });

  it("deletes a tombstoned edge + its edge-key entry, leaving node-degree untouched", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.graphEdges, "ge_1", edge("ge_1", "a", "b"));
    await kv.set(KV.graphEdgeKey, edgeKey("a", "b", "related_to"), "ge_1");
    await kv.set(KV.graphNodeDegree, "a", 5);
    await kv.set(KV.graphTombstones, "ge_1", {
      id: "ge_1",
      kind: "edge",
      reason: "cascade",
      indexKey: edgeKey("a", "b", "related_to"),
      tombstonedAt: "2026-04-01T00:00:00Z",
    });

    const res = (await sdk.trigger("mem::graph-vacuum", {})) as { deletedEdges: number };

    expect(res.deletedEdges).toBe(1);
    expect(await kv.get(KV.graphEdges, "ge_1")).toBeNull();
    expect(await kv.get(KV.graphEdgeKey, edgeKey("a", "b", "related_to"))).toBeNull();
    // Node degree is bookkept at tombstone time, never touched by vacuum.
    expect(await kv.get(KV.graphNodeDegree, "a")).toBe(5);
  });

  it("deletes at most `budget` tombstones per run and reports the remainder", async () => {
    const { kv, sdk } = setup();
    for (let i = 0; i < 5; i++) {
      await kv.set(KV.graphNodes, `gn_${i}`, node(`gn_${i}`, "concept", `n${i}`));
      await kv.set(KV.graphTombstones, `gn_${i}`, {
        id: `gn_${i}`,
        kind: "node",
        reason: "cascade",
        indexKey: nameKey("concept", `n${i}`),
        tombstonedAt: "2026-04-01T00:00:00Z",
      });
    }

    const res = (await sdk.trigger("mem::graph-vacuum", { budget: 2 })) as {
      deletedNodes: number;
      remaining: number;
    };

    expect(res.deletedNodes).toBe(2);
    expect(res.remaining).toBe(3);
    expect((await kv.list(KV.graphTombstones)).length).toBe(3);
  });

  it("is a no-op when there are no tombstones", async () => {
    const { sdk } = setup();
    const res = (await sdk.trigger("mem::graph-vacuum", {})) as {
      success: boolean;
      deletedNodes: number;
      deletedEdges: number;
      remaining: number;
      skippedStale: number;
    };
    expect(res.success).toBe(true);
    expect(res.deletedNodes).toBe(0);
    expect(res.deletedEdges).toBe(0);
    expect(res.remaining).toBe(0);
    expect(res.skippedStale).toBe(0);
  });

  it("skips deleting a prune node whose sourceObservationIds length changed since the tombstone", async () => {
    const { kv, sdk } = setup();
    // Row was doomed as an orphan (1 source), then re-merged live (now 2 sources).
    await kv.set(KV.graphNodes, "gn_live", {
      ...node("gn_live", "concept", "bar"),
      sourceObservationIds: ["obsA", "obsB"],
    });
    await kv.set(KV.graphNameIndex, nameKey("concept", "bar"), "gn_live");
    await kv.set(KV.graphNodeDegree, "gn_live", 2);
    await kv.set(KV.graphTombstones, "gn_live", {
      id: "gn_live",
      kind: "node",
      reason: "prune",
      indexKey: nameKey("concept", "bar"),
      tombstonedAt: "2026-04-01T00:00:00Z",
      observedSourceCount: 1,
    });

    const res = (await sdk.trigger("mem::graph-vacuum", {})) as {
      deletedNodes: number;
      skippedStale: number;
      remaining: number;
    };

    expect(res.deletedNodes).toBe(0);
    expect(res.skippedStale).toBe(1);
    expect(await kv.get(KV.graphNodes, "gn_live")).not.toBeNull();
    expect(await kv.get(KV.graphNameIndex, nameKey("concept", "bar"))).toBe("gn_live");
    expect(await kv.get(KV.graphNodeDegree, "gn_live")).toBe(2);
    // The stale tombstone is dropped so the vacuum does not retry it forever.
    expect(await kv.get(KV.graphTombstones, "gn_live")).toBeNull();
  });

  it("skips deleting a prune edge whose sourceObservationIds length changed since the tombstone", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.graphEdges, "ge_live", {
      ...edge("ge_live", "a", "b"),
      sourceObservationIds: ["o1", "o2", "o3"],
    });
    await kv.set(KV.graphEdgeKey, edgeKey("a", "b", "related_to"), "ge_live");
    await kv.set(KV.graphTombstones, "ge_live", {
      id: "ge_live",
      kind: "edge",
      reason: "prune",
      indexKey: edgeKey("a", "b", "related_to"),
      tombstonedAt: "2026-04-01T00:00:00Z",
      observedSourceCount: 1,
    });

    const res = (await sdk.trigger("mem::graph-vacuum", {})) as {
      deletedEdges: number;
      skippedStale: number;
    };

    expect(res.deletedEdges).toBe(0);
    expect(res.skippedStale).toBe(1);
    expect(await kv.get(KV.graphEdges, "ge_live")).not.toBeNull();
    expect(await kv.get(KV.graphEdgeKey, edgeKey("a", "b", "related_to"))).toBe("ge_live");
    expect(await kv.get(KV.graphTombstones, "ge_live")).toBeNull();
  });

  it("skips deletion when provenance changes without changing source count", async () => {
    const { kv, sdk } = setup();
    const liveNode = {
      ...node("gn_live", "concept", "bar"),
      sourceObservationIds: ["obs_new"],
    };
    await kv.set(KV.graphNodes, liveNode.id, liveNode);
    await recordGraphTombstone(kv as never, {
      id: liveNode.id,
      kind: "node",
      reason: "prune",
      indexKey: nameKey(liveNode.type, liveNode.name),
      observedSourceIds: ["obs_old"],
    });

    const result = (await sdk.trigger("mem::graph-vacuum", {})) as {
      deletedNodes: number;
      skippedStale: number;
    };

    expect(result.deletedNodes).toBe(0);
    expect(result.skippedStale).toBe(1);
    expect(await kv.get(KV.graphNodes, liveNode.id)).toEqual(liveNode);
    expect(await kv.get(KV.graphTombstones, liveNode.id)).toBeNull();
  });

  it("clears an already-deleted prune row without a graph snapshot", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.graphNameIndex, "concept|missing", "gn_missing");
    await kv.set(KV.graphTombstones, "gn_missing", {
      id: "gn_missing",
      kind: "node",
      reason: "prune",
      indexKey: "concept|missing",
      tombstonedAt: "2026-04-01T00:00:00Z",
      observedSourceCount: 1,
      nodeType: "concept",
    });

    const result = (await sdk.trigger("mem::graph-vacuum", {})) as {
      success: boolean;
      skippedStale: number;
      remaining: number;
    };

    expect(result).toMatchObject({
      success: true,
      skippedStale: 1,
      remaining: 0,
    });
    expect(await kv.get(KV.graphNameIndex, "concept|missing")).toBeNull();
    expect(await kv.get(KV.graphTombstones, "gn_missing")).toBeNull();
  });

  it("deletes a prune-tombstoned node when its sourceObservationIds length is unchanged", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.graphNodes, "gn_dead", {
      ...node("gn_dead", "concept", "baz"),
      sourceObservationIds: ["obsX"],
    });
    await kv.set(KV.graphNameIndex, nameKey("concept", "baz"), "gn_dead");
    await kv.set(KV.graphTombstones, "gn_dead", {
      id: "gn_dead",
      kind: "node",
      reason: "prune",
      indexKey: nameKey("concept", "baz"),
      tombstonedAt: "2026-04-01T00:00:00Z",
      observedSourceCount: 1,
    });

    const res = (await sdk.trigger("mem::graph-vacuum", {})) as {
      deletedNodes: number;
      skippedStale: number;
    };

    expect(res.deletedNodes).toBe(1);
    expect(res.skippedStale).toBe(0);
    expect(await kv.get(KV.graphNodes, "gn_dead")).toBeNull();
    expect(await kv.get(KV.graphNameIndex, nameKey("concept", "baz"))).toBeNull();
  });

  it("decrements snapshot stats when it deletes a prune edge", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 10,
        totalEdges: 5,
        nodesByType: { concept: 10 },
        edgesByType: { related_to: 5 },
      },
      updatedAt: "2026-04-01T00:00:00Z",
      dirty: false,
    });
    await kv.set(KV.graphEdges, "ge_p", {
      ...edge("ge_p", "a", "b"),
      sourceObservationIds: ["o1"],
    });
    await kv.set(KV.graphEdgeKey, edgeKey("a", "b", "related_to"), "ge_p");
    await kv.set(KV.graphTombstones, "ge_p", {
      id: "ge_p",
      kind: "edge",
      reason: "prune",
      indexKey: edgeKey("a", "b", "related_to"),
      tombstonedAt: "2026-04-01T00:00:00Z",
      observedSourceCount: 1,
    });

    const res = (await sdk.trigger("mem::graph-vacuum", {})) as {
      deletedEdges: number;
    };
    expect(res.deletedEdges).toBe(1);

    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    expect(snap!.stats.totalEdges).toBe(4);
    expect(snap!.stats.edgesByType.related_to).toBe(4);
    expect(snap!.stats.totalNodes).toBe(10);
  });

  it("removes a pruned edge from the snapshot and decrements endpoint degrees", async () => {
    const { kv, sdk } = setup();
    const left = node("left");
    const right = node("right");
    const doomed = {
      ...edge("ge_top", left.id, right.id),
      sourceObservationIds: ["gone"],
    };
    await kv.set(KV.graphNodes, left.id, left);
    await kv.set(KV.graphNodes, right.id, right);
    await kv.set(KV.graphNodeDegree, left.id, 1);
    await kv.set(KV.graphNodeDegree, right.id, 1);
    await kv.set(KV.graphEdges, doomed.id, doomed);
    await kv.set(
      KV.graphEdgeKey,
      edgeKey(left.id, right.id, doomed.type),
      doomed.id,
    );
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [left, right],
      topEdges: [doomed],
      topDegrees: { left: 1, right: 1 },
      stats: {
        totalNodes: 2,
        totalEdges: 1,
        nodesByType: { concept: 2 },
        edgesByType: { related_to: 1 },
      },
      updatedAt: "2026-04-01T00:00:00Z",
      dirty: false,
    });
    await kv.set(KV.graphTombstones, doomed.id, {
      id: doomed.id,
      kind: "edge",
      reason: "prune",
      indexKey: edgeKey(left.id, right.id, doomed.type),
      tombstonedAt: "2026-04-01T00:00:00Z",
      observedSourceCount: 1,
    });

    await sdk.trigger("mem::graph-vacuum", {});

    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    expect(snap?.topEdges).toEqual([]);
    expect(snap?.topDegrees).toMatchObject({ left: 0, right: 0 });
    expect(snap?.stats.totalEdges).toBe(0);
    expect(await kv.get(KV.graphNodeDegree, left.id)).toBe(0);
    expect(await kv.get(KV.graphNodeDegree, right.id)).toBe(0);
  });

  it("repairs snapshot state when a pruned edge row is already missing", async () => {
    const { kv, sdk } = setup();
    const left = node("left");
    const right = node("right");
    const missing = edge("ge_missing", left.id, right.id);
    await kv.set(KV.graphNodes, left.id, left);
    await kv.set(KV.graphNodes, right.id, right);
    await kv.set(KV.graphNodeDegree, left.id, 1);
    await kv.set(KV.graphNodeDegree, right.id, 1);
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [left, right],
      topEdges: [missing],
      topDegrees: { left: 1, right: 1 },
      stats: {
        totalNodes: 2,
        totalEdges: 1,
        nodesByType: { concept: 2 },
        edgesByType: { related_to: 1 },
      },
      updatedAt: "2026-04-01T00:00:00Z",
      dirty: false,
    });
    await kv.set(KV.graphTombstones, missing.id, {
      id: missing.id,
      kind: "edge",
      reason: "prune",
      indexKey: edgeKey(left.id, right.id, missing.type),
      tombstonedAt: "2026-04-01T00:00:00Z",
      observedSourceCount: 0,
      edgeType: missing.type,
      sourceNodeId: left.id,
      targetNodeId: right.id,
    });

    const result = (await sdk.trigger("mem::graph-vacuum", {})) as {
      success: boolean;
      skippedStale: number;
    };

    expect(result.success).toBe(true);
    expect(result.skippedStale).toBe(1);
    const snapshot = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    expect(snapshot?.topEdges).toEqual([]);
    expect(snapshot?.topDegrees).toEqual({ left: 0, right: 0 });
    expect(snapshot?.stats.totalEdges).toBe(0);
    expect(await kv.get(KV.graphTombstones, missing.id)).toBeNull();
  });

  it("decrements snapshot stats when it deletes a prune node", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 10,
        totalEdges: 5,
        nodesByType: { concept: 10 },
        edgesByType: { related_to: 5 },
      },
      updatedAt: "2026-04-01T00:00:00Z",
      dirty: false,
    });
    await kv.set(KV.graphNodes, "gn_p", {
      ...node("gn_p", "concept", "p"),
      sourceObservationIds: ["o1"],
    });
    await kv.set(KV.graphNameIndex, nameKey("concept", "p"), "gn_p");
    await kv.set(KV.graphTombstones, "gn_p", {
      id: "gn_p",
      kind: "node",
      reason: "prune",
      indexKey: nameKey("concept", "p"),
      tombstonedAt: "2026-04-01T00:00:00Z",
      observedSourceCount: 1,
    });

    await sdk.trigger("mem::graph-vacuum", {});

    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    expect(snap!.stats.totalNodes).toBe(9);
    expect(snap!.stats.nodesByType.concept).toBe(9);
    expect(snap!.stats.totalEdges).toBe(5);
  });

  it("removes a pruned node and its incident edges from the snapshot", async () => {
    const { kv, sdk } = setup();
    const doomed = {
      ...node("gn_top"),
      sourceObservationIds: ["gone"],
    };
    const survivor = node("gn_keep");
    const incident = edge("ge_incident", doomed.id, survivor.id);
    await kv.set(KV.graphNodes, doomed.id, doomed);
    await kv.set(KV.graphNameIndex, nameKey(doomed.type, doomed.name), doomed.id);
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [doomed, survivor],
      topEdges: [incident],
      topDegrees: { gn_top: 1, gn_keep: 1 },
      stats: {
        totalNodes: 2,
        totalEdges: 1,
        nodesByType: { concept: 2 },
        edgesByType: { related_to: 1 },
      },
      updatedAt: "2026-04-01T00:00:00Z",
      dirty: false,
    });
    await kv.set(KV.graphTombstones, doomed.id, {
      id: doomed.id,
      kind: "node",
      reason: "prune",
      indexKey: nameKey(doomed.type, doomed.name),
      tombstonedAt: "2026-04-01T00:00:00Z",
      observedSourceCount: 1,
    });

    await sdk.trigger("mem::graph-vacuum", {});

    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    expect(snap?.topNodes.map((item) => item.id)).toEqual([survivor.id]);
    expect(snap?.topEdges).toEqual([]);
    expect(snap?.topDegrees).not.toHaveProperty(doomed.id);
    expect(snap?.stats.totalNodes).toBe(1);
  });

  it("does NOT decrement snapshot stats for a non-prune (cascade) deletion", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 10,
        totalEdges: 5,
        nodesByType: { concept: 10 },
        edgesByType: { related_to: 5 },
      },
      updatedAt: "2026-04-01T00:00:00Z",
      dirty: false,
    });
    await kv.set(KV.graphEdges, "ge_c", edge("ge_c", "a", "b"));
    await kv.set(KV.graphTombstones, "ge_c", {
      id: "ge_c",
      kind: "edge",
      reason: "cascade",
      indexKey: edgeKey("a", "b", "related_to"),
      tombstonedAt: "2026-04-01T00:00:00Z",
    });

    const res = (await sdk.trigger("mem::graph-vacuum", {})) as {
      deletedEdges: number;
    };
    expect(res.deletedEdges).toBe(1);

    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    expect(snap!.stats.totalEdges).toBe(5);
    expect(snap!.stats.edgesByType.related_to).toBe(5);
  });

  it("does NOT decrement snapshot stats when a prune deletion is skipped as stale", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 10,
        totalEdges: 5,
        nodesByType: { concept: 10 },
        edgesByType: { related_to: 5 },
      },
      updatedAt: "2026-04-01T00:00:00Z",
      dirty: false,
    });
    await kv.set(KV.graphEdges, "ge_revived", {
      ...edge("ge_revived", "a", "b"),
      sourceObservationIds: ["o1", "o2"],
    });
    await kv.set(KV.graphTombstones, "ge_revived", {
      id: "ge_revived",
      kind: "edge",
      reason: "prune",
      indexKey: edgeKey("a", "b", "related_to"),
      tombstonedAt: "2026-04-01T00:00:00Z",
      observedSourceCount: 1,
    });

    const res = (await sdk.trigger("mem::graph-vacuum", {})) as {
      deletedEdges: number;
      skippedStale: number;
    };
    expect(res.deletedEdges).toBe(0);
    expect(res.skippedStale).toBe(1);

    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    expect(snap!.stats.totalEdges).toBe(5);
  });
});


describe("graph-extract orphan tombstoning", () => {
  it("tombstones a pre-resetAt orphan node when a fresh extract collides by name", async () => {
    const { kv, sdk } = setup();
    provider.compress.mockResolvedValue('<entity type="concept" name="foo"/>');

    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: { totalNodes: 0, totalEdges: 0, nodesByType: {}, edgesByType: {} },
      updatedAt: "2026-01-01T00:00:00Z",
      dirty: false,
      resetAt: "2026-06-01T00:00:00Z",
    });
    await kv.set(KV.graphNodes, "gn_orphan", {
      ...node("gn_orphan", "concept", "foo"),
      createdAt: "2026-01-01T00:00:00Z",
    });
    await kv.set(KV.graphNameIndex, nameKey("concept", "foo"), "gn_orphan");

    await sdk.trigger("mem::graph-extract", {
      observations: [
        {
          id: "obs1",
          sessionId: "s",
          timestamp: "2026-06-15T00:00:00Z",
          type: "file_read",
          title: "t",
          facts: [],
          narrative: "n",
          concepts: [],
          files: [],
          importance: 0.5,
        },
      ],
    });

    const tomb = await kv.get<{ kind: string; reason: string; indexKey: string }>(
      KV.graphTombstones,
      "gn_orphan",
    );
    expect(tomb).not.toBeNull();
    expect(tomb?.kind).toBe("node");
    expect(tomb?.reason).toBe("orphan");
    expect(tomb?.indexKey).toBe(nameKey("concept", "foo"));

    // The index must be repointed to the fresh node, so the vacuum's
    // verify-then-delete will correctly SKIP deleting this key.
    const repointed = await kv.get<string>(
      KV.graphNameIndex,
      nameKey("concept", "foo"),
    );
    expect(repointed).not.toBe("gn_orphan");
    expect(repointed).toBeTruthy();
  });

  it("cancels a tombstone when extraction revives the same canonical row", async () => {
    const { kv, sdk } = setup();
    provider.compress.mockResolvedValue('<entity type="concept" name="foo"/>');
    const observation = {
      id: "obs1",
      sessionId: "s",
      timestamp: "2026-06-15T00:00:00Z",
      type: "file_read",
      title: "t",
      facts: [],
      narrative: "n",
      concepts: [],
      files: [],
      importance: 0.5,
    };
    await sdk.trigger("mem::graph-extract", { observations: [observation] });
    const [stored] = await kv.list<GraphNode>(KV.graphNodes);
    const snapshot = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    snapshot!.topNodes = [];
    snapshot!.topDegrees = {};
    snapshot!.stats.totalNodes = 0;
    snapshot!.stats.nodesByType = {};
    await kv.set(KV.graphSnapshot, "current", snapshot!);
    await kv.set(KV.graphTombstones, stored.id, {
      id: stored.id,
      kind: "node",
      reason: "retention",
      indexKey: nameKey(stored.type, stored.name),
      tombstonedAt: "2026-06-15T00:00:00Z",
      observedSourceCount: 1,
    });

    await sdk.trigger("mem::graph-extract", {
      observations: [{ ...observation, id: "obs2" }],
    });

    expect(await kv.get(KV.graphTombstones, stored.id)).toBeNull();
    const revived = await kv.get<GraphNode>(KV.graphNodes, stored.id);
    expect(revived?.stale).toBe(false);
    expect(revived?.sourceObservationIds.sort()).toEqual(["obs1", "obs2"]);
    const revivedSnapshot = await kv.get<GraphSnapshot>(
      KV.graphSnapshot,
      "current",
    );
    expect(revivedSnapshot?.stats.totalNodes).toBe(1);
    expect(revivedSnapshot?.topNodes.map((item) => item.id)).toEqual([
      stored.id,
    ]);
  });
});

describe("retention cap (AGENTMEMORY_GRAPH_RETENTION_CAP)", () => {
  afterEach(() => {
    delete process.env.AGENTMEMORY_GRAPH_RETENTION_CAP;
  });

  // A snapshot at the top-N cap (SNAPSHOT_TOP_NODES = 500), all degree 1, so
  // promoting a higher-degree node forces a tail eviction.
  function fullSnapshot(): GraphSnapshot {
    const topNodes = Array.from({ length: 500 }, (_, i) =>
      node(`t${i}`, "concept", `t${i}`),
    );
    const topDegrees: Record<string, number> = {};
    for (const n of topNodes) topDegrees[n.id] = 1;
    return {
      version: 1,
      topNodes,
      topEdges: [],
      topDegrees,
      stats: {
        totalNodes: 500,
        totalEdges: 0,
        nodesByType: { concept: 500 },
        edgesByType: {},
      },
      updatedAt: "2026-04-01T00:00:00Z",
      dirty: false,
    };
  }

  it("tombstones the evicted node when the cap is ON", async () => {
    process.env.AGENTMEMORY_GRAPH_RETENTION_CAP = "true";
    const kv = mockKV();
    const snap = fullSnapshot();
    await kv.set(KV.graphNodes, "gn_hot", node("gn_hot", "concept", "hot"));
    await kv.set(KV.graphNodeDegree, "gn_hot", 1);

    await applyDegreeDelta(kv as never, snap, "gn_hot", 1);

    const tombs = await kv.list<{
      reason: string;
      kind: string;
      observedSourceCount?: number;
    }>(
      KV.graphTombstones,
    );
    expect(tombs.length).toBe(1);
    expect(tombs[0].reason).toBe("retention");
    expect(tombs[0].kind).toBe("node");
    expect(tombs[0].observedSourceCount).toBe(0);
    expect(snap.stats.totalNodes).toBe(499);
    expect(snap.topNodes.some((n) => n.id === "gn_hot")).toBe(true);
    expect(snap.topNodes.some((n) => n.id === "t499")).toBe(false);
  });

  it("evicts but records no tombstone when the cap is OFF (default)", async () => {
    const kv = mockKV();
    const snap = fullSnapshot();
    await kv.set(KV.graphNodes, "gn_hot", node("gn_hot", "concept", "hot"));
    await kv.set(KV.graphNodeDegree, "gn_hot", 1);

    await applyDegreeDelta(kv as never, snap, "gn_hot", 1);

    expect((await kv.list(KV.graphTombstones)).length).toBe(0);
    expect(snap.stats.totalNodes).toBe(500);
    expect(snap.topNodes.some((n) => n.id === "gn_hot")).toBe(true);
  });
});
