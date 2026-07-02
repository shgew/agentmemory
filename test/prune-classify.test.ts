import { describe, it, expect } from "vitest";

import {
  classifyGraph,
  type GraphNode,
  type GraphEdge,
} from "../scripts/prune-classify.js";

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: "concept",
    name: id,
    properties: {},
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
    ...over,
  };
}

function edge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  over: Partial<GraphEdge> = {},
): GraphEdge {
  return {
    id,
    type: "related_to",
    sourceNodeId,
    targetNodeId,
    weight: 1,
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
    ...over,
  };
}

const RESET_AT = "2026-06-18T14:41:30.871Z";

describe("classifyGraph doom rules", () => {
  it("keeps a node whose source observation is still live", () => {
    const nodes = [node("n_live", { sourceObservationIds: ["o1"] })];
    const res = classifyGraph({ nodes, edges: [], liveSet: new Set(["o1"]) });
    expect(res.manifest.nodeIds).toEqual([]);
    expect(res.report.keptNodes).toBe(1);
    expect(res.report.doomedNodes).toBe(0);
    expect(res.prunedSnapshot.stats.totalNodes).toBe(1);
  });

  it("dooms a stale node even when its source is live", () => {
    const nodes = [node("n_stale", { sourceObservationIds: ["o1"], stale: true })];
    const res = classifyGraph({ nodes, edges: [], liveSet: new Set(["o1"]) });
    expect(res.manifest.nodeIds).toEqual(["n_stale"]);
    expect(res.report.doomedNodes).toBe(1);
    expect(res.report.doomedBySignal).toEqual({
      stale: 1,
      preReset: 0,
      noLiveSource: 0,
    });
  });

  it("dooms a node created before resetAt", () => {
    const nodes = [
      node("n_pre", {
        sourceObservationIds: ["o1"],
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ];
    const res = classifyGraph({
      nodes,
      edges: [],
      liveSet: new Set(["o1"]),
      resetAt: RESET_AT,
    });
    expect(res.manifest.nodeIds).toEqual(["n_pre"]);
    expect(res.report.doomedBySignal).toEqual({
      stale: 0,
      preReset: 1,
      noLiveSource: 0,
    });
  });

  it("dooms a node with no live source observation", () => {
    const nodes = [node("n_dead", { sourceObservationIds: ["ghost"] })];
    const res = classifyGraph({ nodes, edges: [], liveSet: new Set(["o1"]) });
    expect(res.manifest.nodeIds).toEqual(["n_dead"]);
    expect(res.report.doomedBySignal).toEqual({
      stale: 0,
      preReset: 0,
      noLiveSource: 1,
    });
  });
});

describe("classifyGraph referential closure", () => {
  it("force-keeps a doomed node that is an endpoint of a kept edge", () => {
    const nodes = [
      node("A", { sourceObservationIds: ["o1"] }),
      node("B", { sourceObservationIds: ["ghost"] }),
    ];
    const edges = [edge("e1", "A", "B", { sourceObservationIds: ["o1"] })];
    const res = classifyGraph({ nodes, edges, liveSet: new Set(["o1"]) });
    expect(res.manifest.nodeIds).not.toContain("B");
    expect(res.manifest.nodeIds).toEqual([]);
    expect(res.manifest.edgeIds).toEqual([]);
    expect(res.report.keptNodes).toBe(2);
    expect(res.report.forcedKeepNodes).toBe(1);
  });

  it("dooms an edge that references a missing endpoint node", () => {
    const nodes = [node("A", { sourceObservationIds: ["o1"] })];
    const edges = [edge("e1", "A", "ghostNode", { sourceObservationIds: ["o1"] })];
    const res = classifyGraph({ nodes, edges, liveSet: new Set(["o1"]) });
    expect(res.manifest.edgeIds).toEqual(["e1"]);
    expect(res.report.keptEdges).toBe(0);
    expect(res.manifest.nodeIds).toEqual([]);
  });

  it("dooms a stale edge while keeping its live endpoints", () => {
    const nodes = [
      node("A", { sourceObservationIds: ["o1"] }),
      node("B", { sourceObservationIds: ["o1"] }),
    ];
    const edges = [
      edge("e1", "A", "B", { sourceObservationIds: ["o1"], stale: true }),
    ];
    const res = classifyGraph({ nodes, edges, liveSet: new Set(["o1"]) });
    expect(res.manifest.edgeIds).toEqual(["e1"]);
    expect(res.report.doomedEdges).toBe(1);
    expect(res.manifest.nodeIds).toEqual([]);
    expect(res.report.doomedBySignal.stale).toBe(1);
  });

  it("never keeps an edge that references a doomed node across a mixed fixture", () => {
    const liveSet = new Set(["o1"]);
    const nodes = [
      node("L1", { sourceObservationIds: ["o1"], createdAt: "2026-07-01T00:00:00Z" }),
      node("L2", { sourceObservationIds: ["o1"], createdAt: "2026-07-01T00:00:00Z" }),
      node("S1", {
        sourceObservationIds: ["o1"],
        createdAt: "2026-07-01T00:00:00Z",
        stale: true,
      }),
      node("P1", { sourceObservationIds: ["o1"], createdAt: "2026-01-01T00:00:00Z" }),
      node("N1", { sourceObservationIds: ["dead"], createdAt: "2026-07-01T00:00:00Z" }),
      node("FK", { sourceObservationIds: ["dead"], createdAt: "2026-07-01T00:00:00Z" }),
    ];
    const edges = [
      edge("eKeep", "L1", "L2", {
        sourceObservationIds: ["o1"],
        createdAt: "2026-07-01T00:00:00Z",
      }),
      edge("eForce", "L1", "FK", {
        sourceObservationIds: ["o1"],
        createdAt: "2026-07-01T00:00:00Z",
      }),
      edge("eStale", "L1", "L2", {
        sourceObservationIds: ["o1"],
        createdAt: "2026-07-01T00:00:00Z",
        stale: true,
      }),
      edge("eDangle", "L1", "ghost", {
        sourceObservationIds: ["o1"],
        createdAt: "2026-07-01T00:00:00Z",
      }),
    ];
    const res = classifyGraph({ nodes, edges, liveSet, resetAt: RESET_AT });

    const doomedNodeSet = new Set(res.manifest.nodeIds);
    const doomedEdgeSet = new Set(res.manifest.edgeIds);
    for (const e of edges) {
      if (doomedEdgeSet.has(e.id)) continue;
      expect(doomedNodeSet.has(e.sourceNodeId)).toBe(false);
      expect(doomedNodeSet.has(e.targetNodeId)).toBe(false);
    }

    expect([...res.manifest.nodeIds].sort()).toEqual(["N1", "P1", "S1"]);
    expect([...res.manifest.edgeIds].sort()).toEqual(["eDangle", "eStale"]);
    expect(res.report.forcedKeepNodes).toBe(1);
    expect(res.report.doomedBySignal).toEqual({
      stale: 2,
      preReset: 1,
      noLiveSource: 2,
    });

    const topSet = new Set(res.prunedSnapshot.topNodes.map((n) => n.id));
    for (const e of res.prunedSnapshot.topEdges) {
      expect(topSet.has(e.sourceNodeId)).toBe(true);
      expect(topSet.has(e.targetNodeId)).toBe(true);
    }
  });
});

describe("classifyGraph prunedSnapshot", () => {
  it("preserves the input resetAt verbatim", () => {
    const nodes = [
      node("A", { sourceObservationIds: ["o1"], createdAt: "2026-07-01T00:00:00Z" }),
    ];
    const res = classifyGraph({
      nodes,
      edges: [],
      liveSet: new Set(["o1"]),
      resetAt: RESET_AT,
    });
    expect(res.prunedSnapshot.resetAt).toBe(RESET_AT);
    expect(res.prunedSnapshot.version).toBe(1);
    expect(res.prunedSnapshot.dirty).toBe(false);
    expect(typeof res.prunedSnapshot.updatedAt).toBe("string");
  });

  it("leaves resetAt undefined when none is provided", () => {
    const nodes = [node("A", { sourceObservationIds: ["o1"] })];
    const res = classifyGraph({ nodes, edges: [], liveSet: new Set(["o1"]) });
    expect(res.prunedSnapshot.resetAt).toBeUndefined();
  });

  it("caps topNodes at topN, counts all kept in stats, restricts topEdges to top nodes", () => {
    const liveSet = new Set(["o1"]);
    const nodes = [
      node("A", { sourceObservationIds: ["o1"] }),
      node("B", { sourceObservationIds: ["o1"] }),
      node("C", { sourceObservationIds: ["o1"] }),
      node("D", { sourceObservationIds: ["o1"] }),
    ];
    const edges = [
      edge("e1", "A", "B", { sourceObservationIds: ["o1"] }),
      edge("e2", "A", "C", { sourceObservationIds: ["o1"] }),
    ];
    const res = classifyGraph({ nodes, edges, liveSet, topN: 2 });

    expect(res.report.keptNodes).toBe(4);
    expect(res.prunedSnapshot.stats.totalNodes).toBe(4);
    expect(res.prunedSnapshot.stats.totalEdges).toBe(2);
    expect(res.prunedSnapshot.topNodes.length).toBe(2);
    expect(res.prunedSnapshot.topNodes.map((n) => n.id)).toEqual(["A", "B"]);
    expect(res.prunedSnapshot.topDegrees).toEqual({ A: 2, B: 1 });
    expect(res.prunedSnapshot.topEdges.map((e) => e.id)).toEqual(["e1"]);
    expect(res.prunedSnapshot.topNodes[0]).toMatchObject({
      id: "A",
      type: "concept",
      name: "A",
    });
    expect(res.prunedSnapshot.stats.nodesByType).toEqual({ concept: 4 });
    expect(res.prunedSnapshot.stats.edgesByType).toEqual({ related_to: 2 });
  });
});
