import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphFunction, applyDegreeDelta } from "../src/functions/graph.js";
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
    };
    expect(res.success).toBe(true);
    expect(res.deletedNodes).toBe(0);
    expect(res.deletedEdges).toBe(0);
    expect(res.remaining).toBe(0);
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

    const tombs = await kv.list<{ reason: string; kind: string }>(
      KV.graphTombstones,
    );
    expect(tombs.length).toBe(1);
    expect(tombs[0].reason).toBe("retention");
    expect(tombs[0].kind).toBe("node");
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