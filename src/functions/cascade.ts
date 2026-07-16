import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Memory, GraphNode, GraphEdge, GraphSnapshot } from "../types.js";
import { recordAudit } from "./audit.js";
import { readGraphSnapshot, SNAPSHOT_KEY } from "../state/graph-snapshot.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  buildSnapshotFromArrays,
  nameIndexKey,
  edgeIndexKey,
  recordGraphTombstone,
} from "./graph.js";

// Above this many live nodes, enumerating the full graphNodes/graphEdges
// scopes serializes a multi-MB frame that stalls the iii worker heartbeat
// At or above it, cascade scopes itself to the bounded snapshot:
// every reader already reads only the snapshot, so evicting the overlapping
// top-degree rows there is read-correct, and those rows are tombstoned for
// physical reclaim by mem::graph-vacuum. Mirrors REBUILD_SAFE_NODE_CEILING.
const CASCADE_SNAPSHOT_CEILING = 25000;

async function decrementNodeDegree(kv: StateKV, nodeId: string): Promise<void> {
  const current = await kv.get<number>(KV.graphNodeDegree, nodeId);
  if (typeof current === "number") {
    await kv.set(KV.graphNodeDegree, nodeId, Math.max(0, current - 1));
  }
}

// The caller holds the graph:merge lock so snapshot cascade cannot race an
// extract mutating the same snapshot.
async function cascadeStaleInSnapshot(
  kv: StateKV,
  snap: GraphSnapshot,
  obsIds: Set<string>,
  now: string,
): Promise<{ nodes: number; edges: number }> {
  let nodes = 0;
  let edges = 0;
  const staleNodeIds = new Set(
    snap.topNodes
      .filter(
        (node) =>
          !node.stale &&
          (node.sourceObservationIds ?? []).some((id) => obsIds.has(id)),
      )
      .map((node) => node.id),
  );

  const keptEdges: GraphEdge[] = [];
  for (const edge of snap.topEdges) {
    const overlap =
      !edge.stale &&
      ((edge.sourceObservationIds ?? []).some((id) => obsIds.has(id)) ||
        staleNodeIds.has(edge.sourceNodeId) ||
        staleNodeIds.has(edge.targetNodeId));
    if (!overlap) {
      keptEdges.push(edge);
      continue;
    }
    edge.stale = true;
    await kv.set(KV.graphEdges, edge.id, edge);
    await recordGraphTombstone(kv, {
      id: edge.id,
      kind: "edge",
      reason: "cascade",
      indexKey: edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type),
      observedSourceIds: edge.sourceObservationIds,
      edgeType: edge.type,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
    });
    snap.stats.totalEdges = Math.max(0, snap.stats.totalEdges - 1);
    snap.stats.edgesByType[edge.type] = Math.max(
      0,
      (snap.stats.edgesByType[edge.type] ?? 0) - 1,
    );
    await decrementNodeDegree(kv, edge.sourceNodeId);
    await decrementNodeDegree(kv, edge.targetNodeId);
    edges++;
  }
  snap.topEdges = keptEdges;

  const keptNodes: GraphNode[] = [];
  for (const node of snap.topNodes) {
    const overlap = staleNodeIds.has(node.id);
    if (!overlap) {
      keptNodes.push(node);
      continue;
    }
    node.stale = true;
    node.updatedAt = now;
    await kv.set(KV.graphNodes, node.id, node);
    await recordGraphTombstone(kv, {
      id: node.id,
      kind: "node",
      reason: "cascade",
      indexKey: nameIndexKey(node.type, node.name),
      observedSourceIds: node.sourceObservationIds,
      nodeType: node.type,
    });
    snap.stats.totalNodes = Math.max(0, snap.stats.totalNodes - 1);
    snap.stats.nodesByType[node.type] = Math.max(
      0,
      (snap.stats.nodesByType[node.type] ?? 0) - 1,
    );
    delete snap.topDegrees[node.id];
    nodes++;
  }
  snap.topNodes = keptNodes;

  if (nodes > 0 || edges > 0) {
    snap.updatedAt = now;
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
  }
  return { nodes, edges };
}

async function cascadeStaleInFullGraph(
  kv: StateKV,
  snap: GraphSnapshot,
  obsIds: Set<string>,
  now: string,
): Promise<{ nodes: number; edges: number }> {
  const [nodes, edges] = await Promise.all([
    kv.list<GraphNode>(KV.graphNodes),
    kv.list<GraphEdge>(KV.graphEdges),
  ]);
  let flaggedNodes = 0;
  let flaggedEdges = 0;
  const staleNodeIds = new Set(
    nodes
      .filter(
        (node) =>
          !node.stale &&
          (node.sourceObservationIds ?? []).some((id) => obsIds.has(id)),
      )
      .map((node) => node.id),
  );

  for (const edge of edges) {
    if (
      edge.stale ||
      (!(edge.sourceObservationIds ?? []).some((id) => obsIds.has(id)) &&
        !staleNodeIds.has(edge.sourceNodeId) &&
        !staleNodeIds.has(edge.targetNodeId))
    ) {
      continue;
    }
    edge.stale = true;
    await kv.set(KV.graphEdges, edge.id, edge);
    await decrementNodeDegree(kv, edge.sourceNodeId);
    await decrementNodeDegree(kv, edge.targetNodeId);
    await recordGraphTombstone(kv, {
      id: edge.id,
      kind: "edge",
      reason: "cascade",
      indexKey: edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type),
      observedSourceIds: edge.sourceObservationIds,
      edgeType: edge.type,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
    });
    flaggedEdges++;
  }

  for (const node of nodes) {
    if (!staleNodeIds.has(node.id)) {
      continue;
    }
    node.stale = true;
    node.updatedAt = now;
    await kv.set(KV.graphNodes, node.id, node);
    await recordGraphTombstone(kv, {
      id: node.id,
      kind: "node",
      reason: "cascade",
      indexKey: nameIndexKey(node.type, node.name),
      observedSourceIds: node.sourceObservationIds,
      nodeType: node.type,
    });
    flaggedNodes++;
  }

  if (flaggedNodes > 0 || flaggedEdges > 0) {
    const rebuilt = buildSnapshotFromArrays(nodes, edges);
    rebuilt.resetAt = snap.resetAt;
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, rebuilt);
  }
  return { nodes: flaggedNodes, edges: flaggedEdges };
}

export function registerCascadeFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::cascade-update",
    async (data: { supersededMemoryId: string }) => {
      if (!data.supersededMemoryId || typeof data.supersededMemoryId !== "string") {
        return { success: false, error: "supersededMemoryId is required" };
      }

      const superseded = await kv.get<Memory>(KV.memories, data.supersededMemoryId);
      if (!superseded) {
        return { success: false, error: "superseded memory not found" };
      }

      let flaggedNodes = 0;
      let flaggedEdges = 0;
      let flaggedMemories = 0;

      const obsIds = new Set(superseded.sourceObservationIds || []);

      if (obsIds.size > 0) {
        const now = new Date().toISOString();
        let cascadeResult: { nodes: number; edges: number } | null;
        try {
          cascadeResult = await withKeyedLock("graph:merge", async () => {
            const snap = await readGraphSnapshot(kv);
            if (!snap) return null;
            return snap.stats.totalNodes >= CASCADE_SNAPSHOT_CEILING
              ? cascadeStaleInSnapshot(kv, snap, obsIds, now)
              : cascadeStaleInFullGraph(kv, snap, obsIds, now);
          });
        } catch (err) {
          return {
            success: false,
            error: `graph cascade failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
        if (!cascadeResult) {
          return {
            success: false,
            error: "graph snapshot unavailable; cascade refused",
          };
        }
        flaggedNodes = cascadeResult.nodes;
        flaggedEdges = cascadeResult.edges;
        if (flaggedNodes > 0 || flaggedEdges > 0) {
          await recordAudit(kv, "consolidate", "mem::cascade-update", [], {
            change: "marked stale and tombstoned from superseded memory",
            supersededMemoryId: data.supersededMemoryId,
            flaggedNodes,
            flaggedEdges,
          });
        }
      }

      const supersededConcepts = new Set(
        (superseded.concepts ?? []).map((c) => c.toLowerCase()),
      );
      if (supersededConcepts.size >= 2) {
        const allMemories = await kv.list<Memory>(KV.memories);
        for (const mem of allMemories) {
          if (mem.id === data.supersededMemoryId) continue;
          if (!mem.isLatest) continue;

          const sharedCount = (mem.concepts ?? []).filter((c) =>
            supersededConcepts.has(c.toLowerCase()),
          ).length;
          if (sharedCount >= 2) {
            flaggedMemories++;
          }
        }
      }

      return {
        success: true,
        flagged: {
          nodes: flaggedNodes,
          edges: flaggedEdges,
          siblingMemories: flaggedMemories,
        },
        total: flaggedNodes + flaggedEdges + flaggedMemories,
      };
    },
  );
}
