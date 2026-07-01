import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Memory, GraphNode, GraphEdge } from "../types.js";
import { recordAudit } from "./audit.js";
import { readGraphSnapshot, SNAPSHOT_KEY } from "../state/graph-snapshot.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { nameIndexKey, edgeIndexKey, recordGraphTombstone } from "./graph.js";

// Above this many live nodes, enumerating the full graphNodes/graphEdges
// scopes serializes a multi-MB frame that stalls the iii worker heartbeat
// (#814/#825). At or above it, cascade scopes itself to the bounded snapshot:
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

// Snapshot-scoped cascade for large corpora. Marks stale + evicts + tombstones
// only the snapshot-resident nodes/edges tied to the superseded observations,
// decrements their stats and endpoint degrees, and persists the snapshot.
// Enumeration-free. The caller holds the graph:merge lock so this cannot race
// an in-flight extract mutating the same snapshot.
async function cascadeStaleInSnapshot(
  kv: StateKV,
  obsIds: Set<string>,
  now: string,
): Promise<{ nodes: number; edges: number }> {
  const snap = await readGraphSnapshot(kv);
  if (!snap) return { nodes: 0, edges: 0 };

  let nodes = 0;
  let edges = 0;

  const keptEdges: GraphEdge[] = [];
  for (const edge of snap.topEdges) {
    const overlap =
      !edge.stale &&
      (edge.sourceObservationIds ?? []).some((id) => obsIds.has(id));
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
    const overlap =
      !node.stale &&
      (node.sourceObservationIds ?? []).some((id) => obsIds.has(id));
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
        const snap = await readGraphSnapshot(kv);
        const totalNodes = snap?.stats.totalNodes ?? 0;

        if (totalNodes >= CASCADE_SNAPSHOT_CEILING) {
          // Large corpus: a full kv.list would stall the worker heartbeat, so
          // scope to the snapshot under the merge lock (cannot race extract).
          const result = await withKeyedLock("graph:merge", () =>
            cascadeStaleInSnapshot(kv, obsIds, now),
          );
          flaggedNodes = result.nodes;
          flaggedEdges = result.edges;
          if (flaggedNodes > 0 || flaggedEdges > 0) {
            await recordAudit(kv, "consolidate", "mem::cascade-update", [], {
              change:
                "marked stale + tombstoned from superseded memory (snapshot-scoped)",
              supersededMemoryId: data.supersededMemoryId,
              flaggedNodes,
              flaggedEdges,
            });
          }
        } else {
          // Small corpus: the full-scope scan is safe and preserves rebuild
          // correctness (rebuild filters !stale).
          const nodes = await kv.list<GraphNode>(KV.graphNodes);
          for (const node of nodes) {
            if (node.stale) continue;
            const overlap = (node.sourceObservationIds ?? []).some((id) =>
              obsIds.has(id),
            );
            if (overlap) {
              node.stale = true;
              node.updatedAt = now;
              await kv.set(KV.graphNodes, node.id, node);
              await recordAudit(kv, "consolidate", "mem::cascade-update", [node.id], {
                resourceType: "GraphNode",
                change: "marked stale from superseded memory",
                supersededMemoryId: data.supersededMemoryId,
              });
              flaggedNodes++;
            }
          }

          const edges = await kv.list<GraphEdge>(KV.graphEdges);
          for (const edge of edges) {
            if (edge.stale) continue;
            const overlap = (edge.sourceObservationIds ?? []).some((id) =>
              obsIds.has(id),
            );
            if (overlap) {
              edge.stale = true;
              await kv.set(KV.graphEdges, edge.id, edge);
              await recordAudit(kv, "consolidate", "mem::cascade-update", [edge.id], {
                resourceType: "GraphEdge",
                change: "marked stale from superseded memory",
                supersededMemoryId: data.supersededMemoryId,
              });
              flaggedEdges++;
            }
          }
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
