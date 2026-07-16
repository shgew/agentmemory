import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerCascadeFunction } from "../src/functions/cascade.js";
import type {
  Memory,
  GraphNode,
  GraphEdge,
  GraphSnapshot,
} from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

async function seedGraphSnapshot(
  kv: ReturnType<typeof mockKV>,
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<void> {
  const topDegrees: Record<string, number> = {};
  for (const node of nodes) topDegrees[node.id] = 0;
  for (const edge of edges) {
    topDegrees[edge.sourceNodeId] = (topDegrees[edge.sourceNodeId] ?? 0) + 1;
    topDegrees[edge.targetNodeId] = (topDegrees[edge.targetNodeId] ?? 0) + 1;
  }
  await kv.set("mem:graph:snapshot", "current", {
    version: 1,
    topNodes: nodes,
    topEdges: edges,
    topDegrees,
    stats: {
      totalNodes: nodes.filter((node) => !node.stale).length,
      totalEdges: edges.filter((edge) => !edge.stale).length,
      nodesByType: {},
      edgesByType: {},
    },
    updatedAt: "2026-03-01T00:00:00Z",
    dirty: false,
  });
}

describe("Cascade Update Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerCascadeFunction(sdk as never, kv as never);
  });

  it("returns error when supersededMemoryId is missing", async () => {
    const result = (await sdk.trigger("mem::cascade-update", {})) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("supersededMemoryId is required");
  });

  it("returns error for non-existent memory", async () => {
    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_missing",
    })) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe("superseded memory not found");
  });

  it("refuses graph mutation when the snapshot is unavailable", async () => {
    const memory: Memory = {
      id: "mem_no_snapshot",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Old fact",
      content: "Old content",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["obs_a"],
    };
    const node: GraphNode = {
      id: "node_no_snapshot",
      type: "concept",
      name: "react",
      properties: {},
      sourceObservationIds: ["obs_a"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    await kv.set("mem:memories", memory.id, memory);
    await kv.set("mem:graph:nodes", node.id, node);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: memory.id,
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/snapshot unavailable/);
    expect(
      (await kv.get<GraphNode>("mem:graph:nodes", node.id))?.stale,
    ).toBeUndefined();
  });

  it("flags graph nodes referencing superseded observation IDs", async () => {
    const memory: Memory = {
      id: "mem_old",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Old fact",
      content: "Old content",
      concepts: ["react"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["obs_a", "obs_b"],
    };
    await kv.set("mem:memories", "mem_old", memory);

    const node: GraphNode = {
      id: "node_1",
      type: "concept",
      name: "react",
      properties: {},
      sourceObservationIds: ["obs_a"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    await kv.set("mem:graph:nodes", "node_1", node);

    const unrelatedNode: GraphNode = {
      id: "node_2",
      type: "file",
      name: "index.ts",
      properties: {},
      sourceObservationIds: ["obs_c"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    await kv.set("mem:graph:nodes", "node_2", unrelatedNode);
    await seedGraphSnapshot(kv, [node, unrelatedNode], []);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_old",
    })) as { success: boolean; flagged: { nodes: number; edges: number } };

    expect(result.success).toBe(true);
    expect(result.flagged.nodes).toBe(1);

    const updated = await kv.get<GraphNode>("mem:graph:nodes", "node_1");
    expect(updated!.stale).toBe(true);

    const unchanged = await kv.get<GraphNode>("mem:graph:nodes", "node_2");
    expect(unchanged!.stale).toBeUndefined();
    const snapshot = await kv.get<{ topNodes: GraphNode[] }>(
      "mem:graph:snapshot",
      "current",
    );
    expect(snapshot?.topNodes.map((item) => item.id)).toEqual(["node_2"]);
  });

  it("flags graph edges referencing superseded observation IDs", async () => {
    const memory: Memory = {
      id: "mem_old2",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "pattern",
      title: "Old pattern",
      content: "Old pattern content",
      concepts: ["testing"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["obs_x"],
    };
    await kv.set("mem:memories", "mem_old2", memory);

    const edge: GraphEdge = {
      id: "edge_1",
      type: "uses",
      sourceNodeId: "node_a",
      targetNodeId: "node_b",
      weight: 1,
      sourceObservationIds: ["obs_x", "obs_y"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    await kv.set("mem:graph:edges", "edge_1", edge);
    await seedGraphSnapshot(kv, [], [edge]);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_old2",
    })) as { success: boolean; flagged: { edges: number } };

    expect(result.success).toBe(true);
    expect(result.flagged.edges).toBe(1);

    const updated = await kv.get<GraphEdge>("mem:graph:edges", "edge_1");
    expect(updated!.stale).toBe(true);
  });

  it("flags edges whose endpoint becomes stale", async () => {
    const memory: Memory = {
      id: "mem_endpoint",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Old endpoint",
      content: "Old endpoint content",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["obs_old"],
    };
    const doomedNode: GraphNode = {
      id: "node_old",
      type: "concept",
      name: "old",
      properties: {},
      sourceObservationIds: ["obs_old"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    const liveNode: GraphNode = {
      id: "node_live",
      type: "concept",
      name: "live",
      properties: {},
      sourceObservationIds: ["obs_live"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    const incidentEdge: GraphEdge = {
      id: "edge_incident",
      type: "related_to",
      sourceNodeId: doomedNode.id,
      targetNodeId: liveNode.id,
      weight: 1,
      sourceObservationIds: ["obs_live"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    await kv.set("mem:memories", memory.id, memory);
    await kv.set("mem:graph:nodes", doomedNode.id, doomedNode);
    await kv.set("mem:graph:nodes", liveNode.id, liveNode);
    await kv.set("mem:graph:edges", incidentEdge.id, incidentEdge);
    await seedGraphSnapshot(kv, [doomedNode, liveNode], [incidentEdge]);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: memory.id,
    })) as { success: boolean; flagged: { nodes: number; edges: number } };

    expect(result).toMatchObject({
      success: true,
      flagged: { nodes: 1, edges: 1 },
    });
    expect(
      (await kv.get<GraphEdge>("mem:graph:edges", incidentEdge.id))?.stale,
    ).toBe(true);
    const snapshot = await kv.get<GraphSnapshot>(
      "mem:graph:snapshot",
      "current",
    );
    expect(snapshot?.topEdges).toEqual([]);
    expect(snapshot?.stats.totalEdges).toBe(0);
  });

  it("counts sibling memories sharing 2+ concepts", async () => {
    const superseded: Memory = {
      id: "mem_superseded",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "architecture",
      title: "React architecture",
      content: "Old arch",
      concepts: ["react", "frontend", "typescript"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
    };
    await kv.set("mem:memories", "mem_superseded", superseded);

    const sibling: Memory = {
      id: "mem_sibling",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "pattern",
      title: "React patterns",
      content: "Sibling memory sharing concepts",
      concepts: ["react", "typescript"],
      files: [],
      sessionIds: [],
      strength: 6,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_sibling", sibling);

    const unrelated: Memory = {
      id: "mem_unrelated",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Python setup",
      content: "Unrelated memory",
      concepts: ["python", "backend"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_unrelated", unrelated);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_superseded",
    })) as { success: boolean; flagged: { siblingMemories: number }; total: number };

    expect(result.success).toBe(true);
    expect(result.flagged.siblingMemories).toBe(1);
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("skips already stale nodes", async () => {
    const memory: Memory = {
      id: "mem_skip",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Skip test",
      content: "Content",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["obs_s"],
    };
    await kv.set("mem:memories", "mem_skip", memory);

    const node: GraphNode = {
      id: "node_stale",
      type: "concept",
      name: "already stale",
      properties: {},
      sourceObservationIds: ["obs_s"],
      createdAt: "2026-03-01T00:00:00Z",
      stale: true,
    };
    await kv.set("mem:graph:nodes", "node_stale", node);
    await seedGraphSnapshot(kv, [node], []);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_skip",
    })) as { success: boolean; flagged: { nodes: number } };

    expect(result.success).toBe(true);
    expect(result.flagged.nodes).toBe(0);
  });

  it("does not flag siblings when fewer than 2 shared concepts", async () => {
    const memory: Memory = {
      id: "mem_one_concept",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "One concept",
      content: "Content",
      concepts: ["react"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
    };
    await kv.set("mem:memories", "mem_one_concept", memory);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_one_concept",
    })) as { success: boolean; flagged: { siblingMemories: number } };

    expect(result.success).toBe(true);
    expect(result.flagged.siblingMemories).toBe(0);
  });

  it("returns zero counts when no sourceObservationIds and < 2 concepts", async () => {
    const memory: Memory = {
      id: "mem_empty",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Empty refs",
      content: "No references",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
    };
    await kv.set("mem:memories", "mem_empty", memory);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_empty",
    })) as { success: boolean; total: number };

    expect(result.success).toBe(true);
    expect(result.total).toBe(0);
  });
  it("scopes cascade to the snapshot and tombstones evicted rows on a large corpus", async () => {
    const memory: Memory = {
      id: "mem_big",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Big corpus fact",
      content: "content",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["obs_a"],
    };
    await kv.set("mem:memories", "mem_big", memory);

    const supNode: GraphNode = {
      id: "gn_x",
      type: "concept",
      name: "x",
      properties: {},
      sourceObservationIds: ["obs_a"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    const keepNode: GraphNode = {
      id: "gn_y",
      type: "concept",
      name: "y",
      properties: {},
      sourceObservationIds: ["obs_z"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    const supEdge: GraphEdge = {
      id: "ge_x",
      type: "related_to",
      sourceNodeId: "gn_x",
      targetNodeId: "gn_y",
      weight: 1,
      sourceObservationIds: ["obs_a"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    await kv.set("mem:graph:nodes", "gn_x", supNode);
    await kv.set("mem:graph:edges", "ge_x", supEdge);
    await kv.set("mem:graph:node-degree", "gn_x", 1);
    await kv.set("mem:graph:node-degree", "gn_y", 1);
    await kv.set("mem:graph:snapshot", "current", {
      version: 1,
      topNodes: [supNode, keepNode],
      topEdges: [supEdge],
      topDegrees: { gn_x: 1, gn_y: 1 },
      stats: {
        totalNodes: 30000,
        totalEdges: 120000,
        nodesByType: { concept: 30000 },
        edgesByType: { related_to: 120000 },
      },
      updatedAt: "2026-03-01T00:00:00Z",
      dirty: false,
    });

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_big",
    })) as { success: boolean; flagged: { nodes: number; edges: number } };

    expect(result.success).toBe(true);
    expect(result.flagged.nodes).toBe(1);
    expect(result.flagged.edges).toBe(1);

    // Tombstoned for physical reclaim (with the correct index keys).
    const nodeTomb = await kv.get<{ reason: string; indexKey: string }>(
      "mem:graph:tombstones",
      "gn_x",
    );
    expect(nodeTomb?.reason).toBe("cascade");
    expect(nodeTomb?.indexKey).toBe("concept|x");
    const edgeTomb = await kv.get<{ reason: string; indexKey: string }>(
      "mem:graph:tombstones",
      "ge_x",
    );
    expect(edgeTomb?.reason).toBe("cascade");
    expect(edgeTomb?.indexKey).toBe("gn_x|gn_y|related_to");

    // Evicted from the snapshot + stats decremented; the unrelated node stays.
    const snap = (await kv.get("mem:graph:snapshot", "current")) as {
      topNodes: GraphNode[];
      topEdges: GraphEdge[];
      stats: { totalNodes: number; totalEdges: number };
    };
    expect(snap.topNodes.some((n) => n.id === "gn_x")).toBe(false);
    expect(snap.topNodes.some((n) => n.id === "gn_y")).toBe(true);
    expect(snap.topEdges.some((e) => e.id === "ge_x")).toBe(false);
    expect(snap.stats.totalNodes).toBe(29999);
    expect(snap.stats.totalEdges).toBe(119999);

    // Surviving endpoint's degree decremented from the removed edge.
    expect(await kv.get("mem:graph:node-degree", "gn_y")).toBe(0);
    // Disk row marked stale.
    const diskNode = (await kv.get<GraphNode>("mem:graph:nodes", "gn_x"))!;
    expect(diskNode.stale).toBe(true);
  });

});
