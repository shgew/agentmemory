import type { ISdk } from "iii-sdk";
import type {
  GraphNode,
  GraphEdge,
  GraphQueryResult,
  GraphSnapshot,
  CompressedObservation,
  MemoryProvider,
  GraphTombstone,
} from "../types.js";
import { GRAPH_NODE_TYPES, GRAPH_EDGE_TYPES } from "../types.js";
import { KV, fingerprintId, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  GRAPH_EXTRACTION_SYSTEM,
  buildGraphExtractionPrompt,
} from "../prompts/graph-extraction.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";
import { isAfter, isAtOrBefore } from "../state/timestamp-compare.js";
import { readGraphSnapshot, SNAPSHOT_KEY } from "../state/graph-snapshot.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { getEnvVar } from "../config.js";

// #753: keep the response payload below the iii state channel ceiling.
// 500 nodes + their incident edges hold well under the limit on the
// reported 11k-node / 28k-edge corpus, and 5,000 is the upper bound a
// caller can request explicitly. Tuned conservatively because edges
// fan out faster than nodes.
const DEFAULT_GRAPH_QUERY_LIMIT = 500;
const MAX_GRAPH_QUERY_LIMIT = 5000;

// #814: the precomputed snapshot covers the top-degree subgraph used by
// the empty-body / nodeType-only branch, the path the viewer hits on
// tab load. Sized to match the default query limit so the snapshot can
// service a default-cap request without falling back to live
// enumeration. Aggregate stats (nodesByType / edgesByType) are computed
// fresh during rebuild and stored alongside.
const SNAPSHOT_TOP_NODES = DEFAULT_GRAPH_QUERY_LIMIT;

// `state::list` over a 75K-node scope can exceed the iii invocation
// timeout. The query handler races the enumeration against this budget
// and falls back to the snapshot (or a warning envelope) when the live
// path is too slow. 6000ms leaves headroom under the default 8s engine
// invocation deadline.
const LIVE_ENUMERATION_BUDGET_MS = 6000;

// Wall-clock budget for one mem::graph-extract orchestration: one or
// more LLM extraction calls plus KV writes (node + edge dedup,
// snapshot inline update). Bounds the whole orchestration via
// iii-sdk's TriggerRequest.timeoutMs, overriding the worker-level
// invocationTimeoutMs default. Each individual outbound LLM fetch is
// separately bounded by AGENTMEMORY_LLM_TIMEOUT_MS. Raise for
// large sessions (hundreds of compressed observations) where the
// extraction LLM call alone exceeds the default 3-min budget.
const GRAPH_EXTRACT_TIMEOUT_MS_DEFAULT = 180_000;

export function getGraphExtractTimeoutMs(): number {
  const raw = getEnvVar("AGENTMEMORY_GRAPH_EXTRACT_TIMEOUT_MS");
  if (!raw) return GRAPH_EXTRACT_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : GRAPH_EXTRACT_TIMEOUT_MS_DEFAULT;
}

// Per-chunk observation budget for mem::graph-extract. The graph prompt is
// denser than summarize (~95 tokens/obs), so a single-shot extract over a
// large session fills the model window and yields zero output. 150 keeps a
// chunk well under a 32K window while staying single-call for typical
// sessions; lower it (e.g. 60) for smaller context windows.
const GRAPH_CHUNK_SIZE_DEFAULT = 150;
const GRAPH_CHUNK_CONCURRENCY_DEFAULT = 6;

export function getGraphChunkSize(): number {
  const raw = getEnvVar("GRAPH_CHUNK_SIZE");
  if (!raw) return GRAPH_CHUNK_SIZE_DEFAULT;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : GRAPH_CHUNK_SIZE_DEFAULT;
}

export function getGraphChunkConcurrency(): number {
  const raw = getEnvVar("GRAPH_CHUNK_CONCURRENCY");
  if (!raw) return GRAPH_CHUNK_CONCURRENCY_DEFAULT;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0
    ? n
    : GRAPH_CHUNK_CONCURRENCY_DEFAULT;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label}: exceeded ${ms}ms budget`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

function emptySnapshot(): GraphSnapshot {
  return {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
    },
    updatedAt: new Date(0).toISOString(),
    dirty: true,
  };
}

export function buildSnapshotFromArrays(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphSnapshot {
  const liveNodes = nodes.filter((n) => !n.stale);
  const liveNodeIds = new Set(liveNodes.map((node) => node.id));
  const liveEdges = edges.filter(
    (edge) =>
      !edge.stale &&
      liveNodeIds.has(edge.sourceNodeId) &&
      liveNodeIds.has(edge.targetNodeId),
  );
  // Build the global degree map once so we can both rank by it AND
  // snapshot the per-top-node values into topDegrees for synchronous
  // re-sort after incremental edge writes.
  const degree = new Map<string, number>();
  for (const e of liveEdges) {
    degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
    degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
  }
  const ranked = [...liveNodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, SNAPSHOT_TOP_NODES);
  const rankedIds = new Set(ranked.map((n) => n.id));
  const topEdges = liveEdges.filter(
    (e) => rankedIds.has(e.sourceNodeId) && rankedIds.has(e.targetNodeId),
  );
  const topDegrees: Record<string, number> = {};
  for (const n of ranked) {
    topDegrees[n.id] = degree.get(n.id) ?? 0;
  }
  const nodesByType: Record<string, number> = {};
  for (const n of liveNodes) {
    nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
  }
  const edgesByType: Record<string, number> = {};
  for (const e of liveEdges) {
    edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
  }
  return {
    version: 1,
    topNodes: ranked,
    topEdges,
    topDegrees,
    stats: {
      totalNodes: liveNodes.length,
      totalEdges: liveEdges.length,
      nodesByType,
      edgesByType,
    },
    updatedAt: new Date().toISOString(),
    dirty: false,
  };
}

function paginateFromSnapshot(
  snap: GraphSnapshot,
  filterType: string | undefined,
  limit: number,
  offset: number,
): GraphQueryResult {
  const filteredNodes = filterType
    ? snap.topNodes.filter((n) => n.type === filterType)
    : snap.topNodes;
  const total = filterType
    ? snap.stats.nodesByType[filterType] ?? 0
    : snap.stats.totalNodes;
  const pageNodes = filteredNodes.slice(offset, offset + limit);
  const pageIds = new Set(pageNodes.map((n) => n.id));
  const pageEdges = snap.topEdges.filter(
    (e) => pageIds.has(e.sourceNodeId) && pageIds.has(e.targetNodeId),
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth: 0,
    totalNodes: total,
    totalEdges: snap.stats.totalEdges,
    truncated: total > pageNodes.length,
    limit,
    offset,
    fromSnapshot: true,
  };
}

function snapshotSubgraph(snap: GraphSnapshot): {
  allNodes: GraphNode[];
  allEdges: GraphEdge[];
} {
  const allNodes = snap.topNodes.filter((n) => !n.stale);
  const liveIds = new Set(allNodes.map((n) => n.id));
  const allEdges = snap.topEdges.filter(
    (e) =>
      !e.stale &&
      liveIds.has(e.sourceNodeId) &&
      liveIds.has(e.targetNodeId),
  );
  return { allNodes, allEdges };
}

// #814 v2: the rebuild path won't terminate on corpora large enough
// that kv.list returns a payload too big to JSON.parse without
// starving the iii heartbeat. We don't actually know the corpus size
// without enumerating, but we can refuse to start a rebuild if the
// snapshot's recorded `totalNodes` already exceeds this threshold.
// the rebuild path is unreliable above it, and an incremental
// extract-driven snapshot is the right approach for those corpora.
// Operators above the threshold should use mem::graph-reset and let
// future extracts rebuild incrementally.
const REBUILD_SAFE_NODE_CEILING = 25000;

export function nameIndexKey(type: string, name: string): string {
  return `${type}|${name}`;
}

export function edgeIndexKey(
  sourceNodeId: string,
  targetNodeId: string,
  type: string,
): string {
  return `${sourceNodeId}|${targetNodeId}|${type}`;
}

// Queue a doomed row for deletion by mem::graph-vacuum. Keyed by the doomed id
// so re-recording is idempotent. Prune bookkeeping is deferred until vacuum;
// other callers update snapshot state before recording.
export async function recordGraphTombstone(
  kv: StateKV,
  entry: {
    id: string;
    kind: "node" | "edge";
    reason: "cascade" | "orphan" | "retention" | "prune";
    indexKey: string;
    observedSourceCount?: number;
    observedSourceIds?: string[];
    nodeType?: GraphNode["type"];
    edgeType?: GraphEdge["type"];
    sourceNodeId?: string;
    targetNodeId?: string;
  },
): Promise<void> {
  const { observedSourceIds, ...storedEntry } = entry;
  const tombstone: GraphTombstone = {
    ...storedEntry,
    ...(observedSourceIds
      ? {
          observedSourceCount: observedSourceIds.length,
          observedSourceFingerprint: fingerprintId(
            "graph-source",
            [...new Set(observedSourceIds)].sort().join("\n"),
          ),
        }
      : {}),
    tombstonedAt: new Date().toISOString(),
  };
  await kv.set(KV.graphTombstones, entry.id, tombstone);
}

// Mutates `snap` to apply a +1 (or -1) degree delta for nodeId,
// maintaining the top-N ranking. Returns the new degree. Reads /
// writes the per-node degree counter via targeted kv.get/set so we
// never enumerate. Top-N membership flips when:
//   - node's new degree > current min in topNodes AND it's not in
//     topNodes (promote, evict tail if topNodes is full)
//   - node IS in topNodes and its position needs resorting (re-sort
//     topNodes in place)
export async function applyDegreeDelta(
  kv: StateKV,
  snap: GraphSnapshot,
  nodeId: string,
  delta: number,
): Promise<number> {
  const prev = (await kv.get<number>(KV.graphNodeDegree, nodeId)) ?? 0;
  const next = Math.max(0, prev + delta);
  await kv.set(KV.graphNodeDegree, nodeId, next);

  const inTop = snap.topNodes.findIndex((n) => n.id === nodeId);
  if (inTop !== -1) {
    // Cache the new degree in topDegrees so the comparator runs
    // synchronously over numbers, not async kv.get calls. Re-sort
    // descending by degree.
    snap.topDegrees[nodeId] = next;
    snap.topNodes.sort(
      (a, b) =>
        (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
    );
    return next;
  }

  if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
    // Capacity available: fetch and promote.
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      snap.topNodes.push(node);
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
    return next;
  }

  // topNodes is full; the cutoff is the tail's cached degree.
  const tailEntry = snap.topNodes[snap.topNodes.length - 1];
  if (!tailEntry) return next;
  const tailDegree = snap.topDegrees[tailEntry.id] ?? 0;
  if (next > tailDegree) {
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      const evicted = snap.topNodes.pop();
      if (evicted) {
        delete snap.topDegrees[evicted.id];
        if (getEnvVar("AGENTMEMORY_GRAPH_RETENTION_CAP") === "true") {
          // Opt-in hard cap (default off): the evicted node just fell out of
          // the snapshot and is now invisible to every reader, so queue it for
          // physical deletion rather than leaving it as unbounded archive
          // weight. Its edges linger as reader-invisible orphans, the accepted
          // cost of the aggressive cap.
          await recordGraphTombstone(kv, {
            id: evicted.id,
            kind: "node",
            reason: "retention",
            indexKey: nameIndexKey(evicted.type, evicted.name),
            observedSourceIds: evicted.sourceObservationIds,
            nodeType: evicted.type,
          });
          snap.stats.totalNodes = Math.max(0, snap.stats.totalNodes - 1);
          snap.stats.nodesByType[evicted.type] = Math.max(
            0,
            (snap.stats.nodesByType[evicted.type] ?? 0) - 1,
          );
        }
      }
      snap.topNodes.push(node);
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
  }
  return next;
}

function snapshotPushEdgeIfBothInTop(
  snap: GraphSnapshot,
  edge: GraphEdge,
): void {
  const topIds = new Set(snap.topNodes.map((n) => n.id));
  if (topIds.has(edge.sourceNodeId) && topIds.has(edge.targetNodeId)) {
    // Dedupe in case the same edge gets pushed twice.
    if (!snap.topEdges.find((e) => e.id === edge.id)) {
      snap.topEdges.push(edge);
    }
  }
}

function mergeNode(
  existing: GraphNode,
  incoming: GraphNode,
  obsIds: string[],
  capturedAt: string,
): GraphNode {
  return {
    ...existing,
    sourceObservationIds: [
      ...new Set([
        ...existing.sourceObservationIds,
        ...incoming.sourceObservationIds,
        ...obsIds,
      ]),
    ],
    properties: { ...existing.properties, ...incoming.properties },
    updatedAt: capturedAt,
    stale: false,
  };
}

function mergeEdge(
  existing: GraphEdge,
  obsIds: string[],
): GraphEdge {
  return {
    ...existing,
    sourceObservationIds: [
      ...new Set([...existing.sourceObservationIds, ...obsIds]),
    ],
    stale: false,
  };
}

function resolvePagination(
  rawLimit: number | undefined,
  rawOffset: number | undefined,
): { limit: number; offset: number } {
  const requested = typeof rawLimit === "number" && Number.isFinite(rawLimit)
    ? Math.floor(rawLimit)
    : DEFAULT_GRAPH_QUERY_LIMIT;
  const limit = Math.max(1, Math.min(requested, MAX_GRAPH_QUERY_LIMIT));
  const offset = Math.max(
    0,
    typeof rawOffset === "number" && Number.isFinite(rawOffset)
      ? Math.floor(rawOffset)
      : 0,
  );
  return { limit, offset };
}

function paginate(
  nodes: GraphNode[],
  allEdges: GraphEdge[],
  depth: number,
  limit: number,
  offset: number,
): GraphQueryResult {
  const totalNodes = nodes.length;
  const pageNodes = nodes.slice(offset, offset + limit);
  const pageNodeIds = new Set(pageNodes.map((n) => n.id));
  // Edges restricted to the page so the response payload scales with
  // `limit`, not with the global edge count. An edge is included only
  // when both endpoints land in the page. Half-edges to nodes outside
  // the page would render as dangling links in the viewer.
  const pageEdges = allEdges.filter(
    (e) => pageNodeIds.has(e.sourceNodeId) && pageNodeIds.has(e.targetNodeId),
  );
  // Total edges (for the same node universe). Counted unbounded so the
  // viewer can show "showing X of Y" without re-querying.
  const universeIds = new Set(nodes.map((n) => n.id));
  const totalEdges = allEdges.reduce(
    (count, e) =>
      universeIds.has(e.sourceNodeId) && universeIds.has(e.targetNodeId)
        ? count + 1
        : count,
    0,
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth,
    totalNodes,
    totalEdges,
    truncated: totalNodes > pageNodes.length,
    limit,
    offset,
  };
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][\w:-]*)="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

const GRAPH_NODE_TYPE_SET = new Set<string>(GRAPH_NODE_TYPES);
const GRAPH_EDGE_TYPE_SET = new Set<string>(GRAPH_EDGE_TYPES);

const GRAPH_NODE_TYPE_TYPOS: Readonly<Record<string, string>> = {
  decison: "decision",
  desicion: "decision",
  fucntion: "function",
  funciton: "function",
  libary: "library",
  organisation: "organization",
};

export function normalizeGraphNodeType(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  return GRAPH_NODE_TYPE_TYPOS[trimmed] ?? trimmed;
}

function parseGraphXml(
  xml: string,
  observationIds: string[],
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = new Date().toISOString();

  // Two passes because <entity> can be self-closing or have a body
  // (<property> children). The self-closing form needs `[^>]*[^/]` on
  // the attr group so the trailing `/` isn't swallowed into the match
  // (root cause of #494). The explicit-close form picks up the
  // property block.
  const entitySelfClose = /<entity\b([^>]*?)\/>/g;
  const entityWithBody = /<entity\b([^>]*[^/])>([\s\S]*?)<\/entity>/g;

  const addEntity = (rawAttrs: string, propsBlock = ""): void => {
    const attrs = parseAttrs(rawAttrs);
    const normalizedType = normalizeGraphNodeType(attrs["type"]);
    const name = attrs["name"];
    if (!normalizedType || !name || !GRAPH_NODE_TYPE_SET.has(normalizedType))
      return;
    const type = normalizedType as GraphNode["type"];
    const properties: Record<string, string> = {};
    const propRegex = /<property\s+key="([^"]+)">([^<]*)<\/property>/g;
    let propMatch;
    while ((propMatch = propRegex.exec(propsBlock)) !== null) {
      properties[propMatch[1]] = propMatch[2];
    }
    nodes.push({
      id: generateId("gn"),
      type,
      name,
      properties,
      sourceObservationIds: observationIds,
      createdAt: now,
    });
  };

  let match;
  while ((match = entitySelfClose.exec(xml)) !== null) {
    addEntity(match[1]);
  }
  while ((match = entityWithBody.exec(xml)) !== null) {
    addEntity(match[1], match[2]);
  }

  const nodeByNormName = new Map<string, GraphNode>();
  for (const n of nodes) {
    const key = n.name.trim().toLowerCase();
    if (!nodeByNormName.has(key)) nodeByNormName.set(key, n);
  }

  const addRelationship = (rawAttrs: string): void => {
    const attrs = parseAttrs(rawAttrs);
    const type = attrs["type"] as GraphEdge["type"] | undefined;
    const sourceName = attrs["source"];
    const targetName = attrs["target"];
    if (!type || !sourceName || !targetName || !GRAPH_EDGE_TYPE_SET.has(type)) return;
    const sourceNode = nodeByNormName.get(sourceName.trim().toLowerCase());
    const targetNode = nodeByNormName.get(targetName.trim().toLowerCase());
    if (!sourceNode || !targetNode) return;
    const parsedWeight = parseFloat(attrs["weight"] ?? "");
    const weight = Number.isFinite(parsedWeight) ? parsedWeight : 0.5;
    edges.push({
      id: generateId("ge"),
      type,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      weight: Math.max(0, Math.min(1, weight)),
      sourceObservationIds: observationIds,
      createdAt: now,
    });
  };

  const relSelfClose = /<relationship\b([^>]*?)\/>/g;
  while ((match = relSelfClose.exec(xml)) !== null) {
    addRelationship(match[1]);
  }
  const relWithBody = /<relationship\b([^>]*[^/])>[\s\S]*?<\/relationship>/g;
  while ((match = relWithBody.exec(xml)) !== null) {
    addRelationship(match[1]);
  }

  return { nodes, edges };
}

async function extractChunkWithRetry(
  provider: MemoryProvider,
  chunk: CompressedObservation[],
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] } | null> {
  const prompt = buildGraphExtractionPrompt(
    chunk.map((o) => ({
      title: o.title,
      narrative: o.narrative,
      concepts: o.concepts,
      files: o.files,
      type: o.type,
    })),
  );
  const chunkObsIds = chunk.map((o) => o.id);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await provider.compress(GRAPH_EXTRACTION_SYSTEM, prompt);
      return parseGraphXml(response, chunkObsIds);
    } catch (err) {
      logger.warn("Graph extract chunk failed", {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

async function mergeExtractIntoSnapshot(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<{ newNodeCount: number; newEdgeCount: number }> {
  // Full graph scope reads can block the iii worker heartbeat. The caller holds
  // graph:merge across this snapshot read-modify-write.
  const snap = (await readGraphSnapshot(kv)) ?? emptySnapshot();
  const capturedAt = new Date().toISOString();
  let newNodeCount = 0;
  let newEdgeCount = 0;
  let snapshotChanged = false;
  const newEdgesForTopCheck: GraphEdge[] = [];
  const canonicalNodeIds = new Map<string, string>();

  for (const node of nodes) {
    const indexKey = nameIndexKey(node.type, node.name);
    const existingId = await kv.get<string>(KV.graphNameIndex, indexKey);

    let existing: GraphNode | null = null;
    if (existingId) {
      existing = await kv.get<GraphNode>(KV.graphNodes, existingId);
      if (
        existing &&
        snap.resetAt &&
        typeof existing.createdAt === "string" &&
        existing.createdAt < snap.resetAt
      ) {
        // Pre-reset rows were never counted in the current snapshot epoch.
        await recordGraphTombstone(kv, {
          id: existingId,
          kind: "node",
          reason: "orphan",
          indexKey,
          observedSourceIds: existing.sourceObservationIds,
          nodeType: existing.type,
        });
        existing = null;
      }
    }

    if (existing) {
      const tombstone = await kv.get<GraphTombstone>(
        KV.graphTombstones,
        existing.id,
      );
      const wasLogicallyRemoved =
        existing.stale === true ||
        tombstone?.reason === "cascade" ||
        tombstone?.reason === "retention";
      const merged = mergeNode(existing, node, node.sourceObservationIds, capturedAt);
      await kv.set(KV.graphNodes, existing.id, merged);
      await kv.delete(KV.graphTombstones, existing.id);
      canonicalNodeIds.set(node.id, existing.id);
      const topIdx = snap.topNodes.findIndex((n) => n.id === existing!.id);
      if (topIdx !== -1) {
        snap.topNodes[topIdx] = merged;
        snapshotChanged = true;
      }
      if (wasLogicallyRemoved) {
        snap.stats.totalNodes += 1;
        snap.stats.nodesByType[merged.type] =
          (snap.stats.nodesByType[merged.type] ?? 0) + 1;
        await applyDegreeDelta(kv, snap, merged.id, 0);
        snapshotChanged = true;
      }
    } else {
      await kv.set(KV.graphNodes, node.id, node);
      await kv.set(KV.graphNameIndex, indexKey, node.id);
      await kv.set(KV.graphNodeDegree, node.id, 0);
      canonicalNodeIds.set(node.id, node.id);
      snap.stats.totalNodes += 1;
      snap.stats.nodesByType[node.type] =
        (snap.stats.nodesByType[node.type] ?? 0) + 1;
      newNodeCount += 1;
      snapshotChanged = true;
      if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
        snap.topNodes.push(node);
        snap.topDegrees[node.id] = 0;
      }
    }
  }

  for (const edge of edges) {
    const canonicalEdge: GraphEdge = {
      ...edge,
      sourceNodeId:
        canonicalNodeIds.get(edge.sourceNodeId) ?? edge.sourceNodeId,
      targetNodeId:
        canonicalNodeIds.get(edge.targetNodeId) ?? edge.targetNodeId,
    };
    const eKey = edgeIndexKey(
      canonicalEdge.sourceNodeId,
      canonicalEdge.targetNodeId,
      canonicalEdge.type,
    );
    const existingId = await kv.get<string>(KV.graphEdgeKey, eKey);

    let existing: GraphEdge | null = null;
    if (existingId) {
      existing = await kv.get<GraphEdge>(KV.graphEdges, existingId);
      if (
        existing &&
        snap.resetAt &&
        typeof existing.createdAt === "string" &&
        existing.createdAt < snap.resetAt
      ) {
        await recordGraphTombstone(kv, {
          id: existingId,
          kind: "edge",
          reason: "orphan",
          indexKey: eKey,
          observedSourceIds: existing.sourceObservationIds,
          edgeType: existing.type,
          sourceNodeId: existing.sourceNodeId,
          targetNodeId: existing.targetNodeId,
        });
        existing = null;
      }
    }

    if (existing) {
      const tombstone = await kv.get<GraphTombstone>(
        KV.graphTombstones,
        existing.id,
      );
      const wasLogicallyRemoved =
        existing.stale === true || tombstone?.reason === "cascade";
      const merged = mergeEdge(existing, canonicalEdge.sourceObservationIds);
      await kv.set(KV.graphEdges, existing.id, merged);
      await kv.delete(KV.graphTombstones, existing.id);
      const topIdx = snap.topEdges.findIndex((e) => e.id === existing!.id);
      if (topIdx !== -1) {
        snap.topEdges[topIdx] = merged;
        snapshotChanged = true;
      }
      if (wasLogicallyRemoved) {
        snap.stats.totalEdges += 1;
        snap.stats.edgesByType[merged.type] =
          (snap.stats.edgesByType[merged.type] ?? 0) + 1;
        await applyDegreeDelta(kv, snap, merged.sourceNodeId, +1);
        await applyDegreeDelta(kv, snap, merged.targetNodeId, +1);
        snapshotPushEdgeIfBothInTop(snap, merged);
        snapshotChanged = true;
      }
    } else {
      await kv.set(KV.graphEdges, canonicalEdge.id, canonicalEdge);
      await kv.set(KV.graphEdgeKey, eKey, canonicalEdge.id);
      snap.stats.totalEdges += 1;
      snap.stats.edgesByType[canonicalEdge.type] =
        (snap.stats.edgesByType[canonicalEdge.type] ?? 0) + 1;
      newEdgeCount += 1;
      snapshotChanged = true;
      await applyDegreeDelta(kv, snap, canonicalEdge.sourceNodeId, +1);
      await applyDegreeDelta(kv, snap, canonicalEdge.targetNodeId, +1);
      newEdgesForTopCheck.push(canonicalEdge);
    }
  }

  for (const edge of newEdgesForTopCheck) {
    snapshotPushEdgeIfBothInTop(snap, edge);
  }

  if (snapshotChanged) {
    snap.updatedAt = capturedAt;
    snap.dirty = false;
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
  }

  return { newNodeCount, newEdgeCount };
}

export function registerGraphFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::graph-extract", 
    async (data: { observations: CompressedObservation[]; since?: string; until?: string }) => {
      if (!data.observations || data.observations.length === 0) {
        return { success: false, error: "No observations provided" };
      }
      const since = data.since;
      const until = data.until;
      const filtered = (since || until)
        ? data.observations.filter((o) => {
            if (since && !isAfter(o.timestamp, since)) return false;
            if (until && !isAtOrBefore(o.timestamp, until)) return false;
            return true;
          })
        : data.observations;
      if (filtered.length === 0) {
        return { success: false, error: "No observations in window" };
      }

      try {
        const chunkSize = getGraphChunkSize();
        const obsIds = filtered.map((o) => o.id);
        let nodes: GraphNode[] = [];
        let edges: GraphEdge[] = [];
        let failedChunks = 0;
        let failedObservationIds: string[] = [];
        let totalChunks = 1;

        if (filtered.length <= chunkSize) {
          const response = await provider.compress(
            GRAPH_EXTRACTION_SYSTEM,
            buildGraphExtractionPrompt(
              filtered.map((o) => ({
                title: o.title,
                narrative: o.narrative,
                concepts: o.concepts,
                files: o.files,
                type: o.type,
              })),
            ),
          );
          const parsed = parseGraphXml(response, obsIds);
          nodes = parsed.nodes;
          edges = parsed.edges;
        } else {
          const chunks: CompressedObservation[][] = [];
          for (let i = 0; i < filtered.length; i += chunkSize) {
            chunks.push(filtered.slice(i, i + chunkSize));
          }
          totalChunks = chunks.length;
          const concurrency = getGraphChunkConcurrency();
          logger.info("Graph extract chunking session", {
            chunks: chunks.length,
            chunkSize,
            concurrency,
            totalObservations: filtered.length,
          });
          const resultByIdx: Array<{
            nodes: GraphNode[];
            edges: GraphEdge[];
          } | null> = new Array(chunks.length).fill(null);
          for (
            let batchStart = 0;
            batchStart < chunks.length;
            batchStart += concurrency
          ) {
            const batch = chunks.slice(batchStart, batchStart + concurrency);
            await Promise.all(
              batch.map(async (chunk, j) => {
                resultByIdx[batchStart + j] = await extractChunkWithRetry(
                  provider,
                  chunk,
                );
              }),
            );
          }
          const skipped = resultByIdx.filter((r) => r === null).length;
          if (skipped === chunks.length) {
            return {
              success: false,
              error: "all_chunks_failed",
              failedChunks: skipped,
              totalChunks: chunks.length,
              failedObservationIds: obsIds,
            };
          }
          if (skipped > 0) {
            failedChunks = skipped;
            failedObservationIds = resultByIdx.flatMap((result, index) =>
              result === null
                ? chunks[index].map((observation) => observation.id)
                : [],
            );
            logger.warn("Graph extract chunks partially skipped", {
              skipped,
              total: chunks.length,
            });
          }
          for (const r of resultByIdx) {
            if (r) {
              nodes.push(...r.nodes);
              edges.push(...r.edges);
            }
          }
        }

        const { newNodeCount, newEdgeCount } = await withKeyedLock(
          "graph:merge",
          () => mergeExtractIntoSnapshot(kv, nodes, edges),
        );

        await recordAudit(kv, "observe", "mem::graph-extract", obsIds, {
          nodesExtracted: nodes.length,
          edgesExtracted: edges.length,
          failedChunks,
          totalChunks,
          failedObservationIds,
        });

        logger.info("Graph extraction complete", {
          nodes: nodes.length,
          edges: edges.length,
          newNodes: newNodeCount,
          newEdges: newEdgeCount,
        });
        return {
          success: failedChunks === 0,
          ...(failedChunks > 0
            ? { error: "partial_chunks_failed", partial: true }
            : {}),
          nodesAdded: nodes.length,
          edgesAdded: edges.length,
          failedChunks,
          totalChunks,
          failedObservationIds,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Graph extraction failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );

  // #753: every branch now applies a default cap and reports the
  // unbounded `total*` counts. Before this change, an unfiltered POST
  // /graph/query body (`{}`) on a corpus with ~10k+ nodes serialized
  // to a payload large enough that the iii state response channel
  // rejected it with HTTP 500 "Invocation stopped", leaving the viewer
  // graph tab silently blank.
  sdk.registerFunction("mem::graph-query",
    async (data: {
      startNodeId?: string;
      nodeType?: string;
      maxDepth?: number;
      query?: string;
      limit?: number;
      offset?: number;
    }): Promise<GraphQueryResult> => {
      const maxDepth = Math.min(data.maxDepth || 3, 5);
      const { limit, offset } = resolvePagination(data.limit, data.offset);

      // #814 v2: the empty-body / nodeType-only path NEVER enumerates.
      // It reads the snapshot exclusively. The snapshot is updated
      // inline by graph-extract, so for newly-built corpora it's
      // always current. For legacy corpora missing a snapshot the
      // operator must run mem::graph-snapshot-rebuild (safe under
      // REBUILD_SAFE_NODE_CEILING) or mem::graph-reset to wipe and
      // rebuild incrementally from new observations.
      const noWalk = !data.query && !data.startNodeId;
      if (noWalk) {
        const snap = await readGraphSnapshot(kv);
        if (snap && snap.stats.totalNodes > 0) {
          return paginateFromSnapshot(snap, data.nodeType, limit, offset);
        }
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          warning:
            "No graph snapshot available. Either no graph has been " +
            "extracted yet, or you are on a corpus from an older " +
            "agentmemory build. Run POST /agentmemory/graph/snapshot-rebuild " +
            "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to " +
            "wipe and let future extracts repopulate.",
        };
      }

      // Full graph scope reads can block the iii worker heartbeat, so query
      // paths use the bounded snapshot.
      const snap = await readGraphSnapshot(kv);
      if (!snap || snap.topNodes.length === 0) {
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          fromSnapshot: true,
          warning:
            "No graph snapshot available. Either no graph has been " +
            "extracted yet, or you are on a corpus from an older " +
            "agentmemory build. Run POST /agentmemory/graph/snapshot-rebuild " +
            "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to " +
            "wipe and let future extracts repopulate.",
        };
      }
      const { allNodes, allEdges } = snapshotSubgraph(snap);
      const snapshotWarning =
        snap.stats.totalNodes > allNodes.length
          ? "Result scoped to the top-degree graph snapshot (" +
            `${allNodes.length} of ${snap.stats.totalNodes} nodes). The ` +
            "query and startNodeId paths read the bounded snapshot, not the " +
            "full graph, so low-degree matches outside the snapshot are not " +
            "returned."
          : undefined;

      if (data.query) {
        const lower = data.query.toLowerCase();
        const matchingNodes = allNodes.filter(
          (n) =>
            n.name.toLowerCase().includes(lower) ||
            Object.values(n.properties).some(
              (v) => typeof v === "string" && v.toLowerCase().includes(lower),
            ),
        );
        return {
          ...paginate(matchingNodes, allEdges, 0, limit, offset),
          fromSnapshot: true,
          ...(snapshotWarning ? { warning: snapshotWarning } : {}),
        };
      }

      if (data.startNodeId) {
        if (!allNodes.some((n) => n.id === data.startNodeId)) {
          return {
            nodes: [],
            edges: [],
            depth: 0,
            totalNodes: 0,
            totalEdges: 0,
            truncated: false,
            limit,
            offset,
            fromSnapshot: true,
            warning:
              "startNodeId is outside the bounded graph snapshot " +
              "(top-degree subgraph). The walk path no longer enumerates " +
              "the full graph; query by name, or widen the snapshot, to " +
              "reach low-degree nodes.",
          };
        }
        const visited = new Set<string>();
        const visitedEdges = new Set<string>();
        const resultNodes: GraphNode[] = [];
        const resultEdges: GraphEdge[] = [];
        const queue: Array<{ nodeId: string; depth: number }> = [
          { nodeId: data.startNodeId, depth: 0 },
        ];

        while (queue.length > 0) {
          const { nodeId, depth } = queue.shift()!;
          if (visited.has(nodeId) || depth > maxDepth) continue;
          visited.add(nodeId);

          const node = allNodes.find((n) => n.id === nodeId);
          if (node) {
            if (!data.nodeType || node.type === data.nodeType) {
              resultNodes.push(node);
            }
          }

          const neighborEdges = allEdges.filter(
            (e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId,
          );
          for (const edge of neighborEdges) {
            if (!visitedEdges.has(edge.id)) {
              visitedEdges.add(edge.id);
              resultEdges.push(edge);
            }
            const nextId =
              edge.sourceNodeId === nodeId
                ? edge.targetNodeId
                : edge.sourceNodeId;
            if (!visited.has(nextId)) {
              queue.push({ nodeId: nextId, depth: depth + 1 });
            }
          }
        }

        return {
          ...paginate(resultNodes, resultEdges, maxDepth, limit, offset),
          fromSnapshot: true,
          ...(snapshotWarning ? { warning: snapshotWarning } : {}),
        };
      }

      return paginate([], [], 0, limit, offset);
    },
  );

  // #814 v2: graph-stats reads the snapshot exclusively. The snapshot
  // is maintained inline by mem::graph-extract, so for any corpus built
  // on a post-#814 agentmemory the stats are always current without an
  // enumeration. Legacy corpora without a snapshot get an empty
  // envelope + a warning pointing at the snapshot-rebuild or graph-reset
  // endpoints, never a 500.
  sdk.registerFunction("mem::graph-stats", async () => {
    const snap = await readGraphSnapshot(kv);
    if (snap) {
      return {
        ...snap.stats,
        fromSnapshot: true,
        updatedAt: snap.updatedAt,
        ...(snap.dirty
          ? {
              warning:
                "Snapshot is marked dirty (write was in-flight when read). " +
                "Counts are eventually consistent.",
            }
          : {}),
      };
    }
    return {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
      fromSnapshot: false,
      warning:
        "No graph snapshot available. Run POST /agentmemory/graph/snapshot-rebuild " +
        "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to wipe " +
        "and let future extracts repopulate.",
    };
  });

  // #814 v2: explicit rebuild backfills the snapshot AND the name /
  // edge-key / degree indexes from existing graphNodes/graphEdges
  // scopes. This is the path operators run once after upgrading to a
  // post-#814 build to bring legacy corpora online. It enumerates via
  // kv.list, the same pair that breaks at 75K+, so we refuse to
  // run on corpora large enough that the response payload would
  // block the worker heartbeat. Above the ceiling the only safe path
  // is mem::graph-reset followed by incremental re-extraction.
  sdk.registerFunction(
    "mem::graph-snapshot-rebuild",
    async (data?: { force?: boolean }) => {
      const started = Date.now();
      // #825: pre-flight refusal for legacy corpora. The old guard
      // checked node count AFTER kv.list, but the heartbeat dies at
      // ~0.35s on a 75K-node response, long before the wall-clock
      // budget can fire. We can't safely enumerate to discover size.
      //
      // Heuristic: if no snapshot exists, the corpus is either empty
      // or legacy. The empty case has nothing to rebuild; the legacy
      // case will crash. Refuse both unless `force: true` is passed
      // (operator opt-in to attempt rebuild on a corpus they know is
      // small enough, typically under 10K nodes on the default iii
      // state adapter).
      // Strict boolean check on force accepts only literal `true`,
      // never truthy strings/numbers, so a hand-crafted JSON payload
      // can't accidentally bypass the legacy-corpus safeguard.
      const forceRebuild = data?.force === true;
      try {
        const existing = await readGraphSnapshot(kv);
        if (!existing && !forceRebuild) {
          logger.warn("Graph snapshot rebuild refused: no prior snapshot", {
            hint: "legacy corpus or empty store",
          });
          return {
            success: false,
            legacyCorpus: true,
            error:
              "No prior snapshot found. Rebuild would call kv.list on " +
              "KV.graphNodes/Edges, which heartbeat-crashes the worker " +
              "on corpora past the iii state response budget (~25K nodes). " +
              "Either (a) call POST /agentmemory/graph/reset to drop into " +
              "incremental-only mode and rebuild from new extracts, or " +
              "(b) re-send with `force: true` if you're certain the " +
              "corpus is small.",
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Graph snapshot pre-flight read failed", { error: msg });
        // Fall through; the user passed force=true or the snapshot
        // read itself failed (separate problem).
      }

      try {
        const [nodes, edges] = await withTimeout(
          Promise.all([
            kv.list<GraphNode>(KV.graphNodes),
            kv.list<GraphEdge>(KV.graphEdges),
          ]),
          LIVE_ENUMERATION_BUDGET_MS,
          "graph-snapshot-rebuild enumeration",
        );

      if (nodes.length > REBUILD_SAFE_NODE_CEILING) {
        logger.warn("Graph snapshot rebuild aborted: corpus too large", {
          totalNodes: nodes.length,
          ceiling: REBUILD_SAFE_NODE_CEILING,
        });
        return {
          success: false,
          tooLarge: true,
          totalNodes: nodes.length,
          ceiling: REBUILD_SAFE_NODE_CEILING,
          error:
            `Corpus has ${nodes.length} graph nodes; safe-rebuild ceiling ` +
            `is ${REBUILD_SAFE_NODE_CEILING}. Run POST /agentmemory/graph/reset ` +
            `to wipe and let future extracts rebuild incrementally.`,
        };
      }

      // Backfill the targeted-lookup indexes so post-rebuild
      // graph-extract calls hit the O(1) path instead of falling
      // through to the (already-removed) full-scope scan. Batch
      // writes via Promise.all to avoid N sequential round-trips.
      // BATCH_SIZE bounds in-flight writes so we don't open thousands
      // of concurrent state channels on huge corpora.
      const liveNodes = nodes.filter((n) => !n.stale);
      const liveEdges = edges.filter((e) => !e.stale);
      const degree = new Map<string, number>();
      for (const e of liveEdges) {
        degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
        degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
      }
      const BATCH_SIZE = 100;
      for (let i = 0; i < liveNodes.length; i += BATCH_SIZE) {
        const batch = liveNodes.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.flatMap((n) => [
            kv.set(KV.graphNameIndex, nameIndexKey(n.type, n.name), n.id),
            kv.set(KV.graphNodeDegree, n.id, degree.get(n.id) ?? 0),
          ]),
        );
      }
      for (let i = 0; i < liveEdges.length; i += BATCH_SIZE) {
        const batch = liveEdges.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map((e) =>
            kv.set(
              KV.graphEdgeKey,
              edgeIndexKey(e.sourceNodeId, e.targetNodeId, e.type),
              e.id,
            ),
          ),
        );
      }

      const snap = buildSnapshotFromArrays(nodes, edges);
      await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
      const tookMs = Date.now() - started;
      logger.info("Graph snapshot rebuilt", {
        totalNodes: snap.stats.totalNodes,
        totalEdges: snap.stats.totalEdges,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        tookMs,
      });
      return {
        success: true,
        ...snap.stats,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        updatedAt: snap.updatedAt,
        tookMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Graph snapshot rebuild failed", { error: msg });
      return { success: false, error: msg };
    }
  });

  // Reset is enumeration-free because full graph scope reads can block the
  // worker. Existing rows remain unreachable until vacuum deletes them.
  sdk.registerFunction("mem::graph-reset", async () => {
    const started = Date.now();
    // resetAt prevents extracts from reconnecting indexed rows from an older
    // snapshot epoch.
    const resetSnapshot: GraphSnapshot = {
      ...emptySnapshot(),
      resetAt: new Date().toISOString(),
    };
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, resetSnapshot);
    const counts: Record<string, number> = {
      [KV.graphSnapshot]: 1,
    };
    const tookMs = Date.now() - started;
    logger.info("Graph state reset", { counts, tookMs });
    return { success: true, cleared: counts, tookMs };
  });

  // Normalizes stored node rows and their snapshot copies in one pass.
  sdk.registerFunction(
    "mem::graph-normalize-types",
    async (data?: { dryRun?: boolean }) => {
      const dryRun = data?.dryRun === true;
      const started = Date.now();
      let result:
        | {
            success: true;
            scanned: number;
            fixed: number;
            snapshotUpdated: boolean;
          }
        | {
            success: false;
            scanned: number;
            fixed: number;
            snapshotUpdated: false;
            error: string;
          };

      try {
        result = await withKeyedLock("graph:merge", async () => {
          const nodes = await kv.list<GraphNode>(KV.graphNodes);
          const rawSnapshot = await kv.get<GraphSnapshot>(
            KV.graphSnapshot,
            SNAPSHOT_KEY,
          );
          const snap = rawSnapshot?.version === 1 ? rawSnapshot : null;
          const plans: Array<{
            node: GraphNode;
            normalizedType: GraphNode["type"];
            oldIndexKey: string;
            newIndexKey: string;
          }> = [];
          let scanned = 0;
          const plannedOwners = new Map<string, string>();

          for (const node of nodes) {
            if (!node || typeof node.id !== "string") continue;
            scanned++;
            const normalized = normalizeGraphNodeType(node.type);
            if (
              !normalized ||
              normalized === node.type ||
              !GRAPH_NODE_TYPE_SET.has(normalized)
            ) {
              continue;
            }
            const newIndexKey = nameIndexKey(normalized, node.name);
            const plannedOwner = plannedOwners.get(newIndexKey);
            const storedOwner = await kv.get<string>(
              KV.graphNameIndex,
              newIndexKey,
            );
            const collisionOwner = plannedOwner ?? storedOwner;
            if (collisionOwner && collisionOwner !== node.id) {
              return {
                success: false as const,
                scanned,
                fixed: 0,
                snapshotUpdated: false as const,
                error: `normalized name-index collision for ${newIndexKey}`,
              };
            }
            plannedOwners.set(newIndexKey, node.id);
            plans.push({
              node,
              normalizedType: normalized as GraphNode["type"],
              oldIndexKey: nameIndexKey(node.type, node.name),
              newIndexKey,
            });
          }

          if (!dryRun) {
            for (const plan of plans) {
              await kv.set(KV.graphNodes, plan.node.id, {
                ...plan.node,
                type: plan.normalizedType,
              });
              const oldOwner = await kv.get<string>(
                KV.graphNameIndex,
                plan.oldIndexKey,
              );
              if (oldOwner === plan.node.id) {
                await kv.delete(KV.graphNameIndex, plan.oldIndexKey);
              }
              await kv.set(
                KV.graphNameIndex,
                plan.newIndexKey,
                plan.node.id,
              );
            }
          }

          const remap = new Map(
            plans.map((plan) => [plan.node.id, plan.normalizedType]),
          );
          let snapshotUpdated = false;
          if (snap) {
            for (const node of snap.topNodes) {
              const normalized =
                remap.get(node.id) ?? normalizeGraphNodeType(node.type);
              if (
                normalized &&
                normalized !== node.type &&
                GRAPH_NODE_TYPE_SET.has(normalized)
              ) {
                snapshotUpdated = true;
                if (!dryRun) {
                  node.type = normalized as GraphNode["type"];
                }
              }
            }
            const nodesByType: Record<string, number> = {};
            for (const [type, count] of Object.entries(snap.stats.nodesByType)) {
              const normalized = normalizeGraphNodeType(type);
              const target =
                normalized && GRAPH_NODE_TYPE_SET.has(normalized)
                  ? normalized
                  : type;
              if (target !== type) snapshotUpdated = true;
              nodesByType[target] = (nodesByType[target] ?? 0) + count;
            }
            if (snapshotUpdated && !dryRun) {
              snap.stats.nodesByType = nodesByType;
              snap.updatedAt = new Date().toISOString();
              await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
            }
          }

          return {
            success: true as const,
            scanned,
            fixed: plans.length,
            snapshotUpdated,
          };
        });
      } catch (err) {
        result = {
          success: false,
          scanned: 0,
          fixed: 0,
          snapshotUpdated: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      if (!dryRun && result.success && (result.fixed > 0 || result.snapshotUpdated)) {
        await recordAudit(
          kv,
          "consolidate",
          "mem::graph-normalize-types",
          [],
          {
            scanned: result.scanned,
            fixed: result.fixed,
            snapshotUpdated: result.snapshotUpdated,
          },
        );
      }

      const tookMs = Date.now() - started;
      logger.info("Graph node-type normalization", {
        ...result,
        dryRun,
        tookMs,
      });
      return { ...result, dryRun, tookMs };
    },
  );

  // Physical-delete pass for the graph pruning queue. Reads the bounded
  // KV.graphTombstones scope (the ONLY kv.list here, and it stays a tiny
  // frame because it is drained faster than produced) and deletes up to
  // `budget` doomed rows from graphNodes/graphEdges plus their side-index
  // entries. Runs under the graph:merge lock so a concurrent extract cannot
  // resurrect a row this pass deletes. Prune tombstones apply snapshot and
  // degree bookkeeping here after the freshness check succeeds.
  sdk.registerFunction(
    "mem::graph-vacuum",
    async (data?: { budget?: number }) => {
      const DEFAULT_BUDGET = 300;
      const MAX_BUDGET = 5000;
      const envRaw = getEnvVar("AGENTMEMORY_GRAPH_VACUUM_BUDGET");
      const envParsed = envRaw ? Number(envRaw) : DEFAULT_BUDGET;
      const envBudget =
        Number.isFinite(envParsed) && envParsed > 0 ? envParsed : DEFAULT_BUDGET;
      const requestedBudget =
        typeof data?.budget === "number" && Number.isFinite(data.budget)
          ? data.budget
          : envBudget;
      const budget = Math.floor(
        Math.max(1, Math.min(requestedBudget, MAX_BUDGET)),
      );

      const started = Date.now();
      let tombstones: GraphTombstone[] = [];
      let batch: GraphTombstone[] = [];
      let deletedNodes = 0;
      let deletedEdges = 0;
      let skippedIndex = 0;
      let skippedStale = 0;
      let clearedTombstones = 0;
      let prunedEdgeCount = 0;
      let prunedNodeCount = 0;
      const prunedEdgesByType: Record<string, number> = {};
      const prunedNodesByType: Record<string, number> = {};

      try {
        await withKeyedLock("graph:merge", async () => {
          tombstones = await kv.list<GraphTombstone>(KV.graphTombstones);
          batch = tombstones.slice(0, budget);
          if (batch.length === 0) return;

          const snap = await readGraphSnapshot(kv);
          let snapshotChanged = false;
          const tombstonesToDelete: string[] = [];

          for (const tombstone of batch) {
            if (!tombstone || typeof tombstone.id !== "string") continue;
            const queued = await kv.get<GraphTombstone>(
              KV.graphTombstones,
              tombstone.id,
            );
            if (
              !queued ||
              queued.tombstonedAt !== tombstone.tombstonedAt ||
              queued.kind !== tombstone.kind
            ) {
              skippedStale++;
              continue;
            }

            const scope =
              tombstone.kind === "edge" ? KV.graphEdges : KV.graphNodes;
            const current = await kv.get<GraphNode | GraphEdge>(
              scope,
              tombstone.id,
            );
            if (
              current &&
              ((tombstone.observedSourceFingerprint !== undefined &&
                fingerprintId(
                  "graph-source",
                  [
                    ...new Set(current.sourceObservationIds ?? []),
                  ].sort().join("\n"),
                ) !== tombstone.observedSourceFingerprint) ||
                (tombstone.observedSourceFingerprint === undefined &&
                  typeof tombstone.observedSourceCount === "number" &&
                  (current.sourceObservationIds?.length ?? 0) !==
                    tombstone.observedSourceCount))
            ) {
              tombstonesToDelete.push(tombstone.id);
              skippedStale++;
              continue;
            }

            if (tombstone.kind === "edge") {
              const edge = current as GraphEdge | null;
              const snapshotEdge = snap?.topEdges.find(
                (item) => item.id === tombstone.id,
              );
              const edgeType =
                edge?.type ?? tombstone.edgeType ?? snapshotEdge?.type;
              const sourceNodeId =
                edge?.sourceNodeId ??
                tombstone.sourceNodeId ??
                snapshotEdge?.sourceNodeId;
              const targetNodeId =
                edge?.targetNodeId ??
                tombstone.targetNodeId ??
                snapshotEdge?.targetNodeId;

              if (snap) {
                const previousLength = snap.topEdges.length;
                snap.topEdges = snap.topEdges.filter(
                  (item) => item.id !== tombstone.id,
                );
                snapshotChanged ||= snap.topEdges.length !== previousLength;
                if (
                  tombstone.reason === "prune" &&
                  sourceNodeId &&
                  targetNodeId
                ) {
                  await applyDegreeDelta(kv, snap, sourceNodeId, -1);
                  await applyDegreeDelta(kv, snap, targetNodeId, -1);
                  snapshotChanged = true;
                }
              }
              if (current) {
                await kv.delete(KV.graphEdges, tombstone.id);
                deletedEdges++;
              } else {
                skippedStale++;
              }
              if (tombstone.indexKey) {
                const indexOwner = await kv.get<string>(
                  KV.graphEdgeKey,
                  tombstone.indexKey,
                );
                if (indexOwner === tombstone.id) {
                  await kv.delete(KV.graphEdgeKey, tombstone.indexKey);
                } else {
                  skippedIndex++;
                }
              }
              if (tombstone.reason === "prune") {
                prunedEdgeCount++;
                if (edgeType) {
                  prunedEdgesByType[edgeType] =
                    (prunedEdgesByType[edgeType] ?? 0) + 1;
                }
              }
            } else {
              const node = current as GraphNode | null;
              const snapshotNode = snap?.topNodes.find(
                (item) => item.id === tombstone.id,
              );
              const nodeType =
                node?.type ?? tombstone.nodeType ?? snapshotNode?.type;
              if (snap) {
                const previousNodeLength = snap.topNodes.length;
                const previousEdgeLength = snap.topEdges.length;
                snap.topNodes = snap.topNodes.filter(
                  (item) => item.id !== tombstone.id,
                );
                snap.topEdges = snap.topEdges.filter(
                  (item) =>
                    item.sourceNodeId !== tombstone.id &&
                    item.targetNodeId !== tombstone.id,
                );
                if (snap.topDegrees[tombstone.id] !== undefined) {
                  delete snap.topDegrees[tombstone.id];
                  snapshotChanged = true;
                }
                snapshotChanged ||=
                  snap.topNodes.length !== previousNodeLength ||
                  snap.topEdges.length !== previousEdgeLength;
              }
              if (current) {
                await kv.delete(KV.graphNodes, tombstone.id);
                deletedNodes++;
              } else {
                skippedStale++;
              }
              await kv.delete(KV.graphNodeDegree, tombstone.id);
              if (tombstone.indexKey) {
                const indexOwner = await kv.get<string>(
                  KV.graphNameIndex,
                  tombstone.indexKey,
                );
                if (indexOwner === tombstone.id) {
                  await kv.delete(KV.graphNameIndex, tombstone.indexKey);
                } else {
                  skippedIndex++;
                }
              }
              if (tombstone.reason === "prune") {
                prunedNodeCount++;
                if (nodeType) {
                  prunedNodesByType[nodeType] =
                    (prunedNodesByType[nodeType] ?? 0) + 1;
                }
              }
            }
            tombstonesToDelete.push(tombstone.id);
          }

          if (snap) {
            if (prunedEdgeCount > 0 || prunedNodeCount > 0) {
              snap.stats.totalEdges = Math.max(
                0,
                snap.stats.totalEdges - prunedEdgeCount,
              );
              snap.stats.totalNodes = Math.max(
                0,
                snap.stats.totalNodes - prunedNodeCount,
              );
              for (const [type, count] of Object.entries(prunedEdgesByType)) {
                const next = Math.max(
                  0,
                  (snap.stats.edgesByType[type] ?? 0) - count,
                );
                if (next === 0) delete snap.stats.edgesByType[type];
                else snap.stats.edgesByType[type] = next;
              }
              for (const [type, count] of Object.entries(prunedNodesByType)) {
                const next = Math.max(
                  0,
                  (snap.stats.nodesByType[type] ?? 0) - count,
                );
                if (next === 0) delete snap.stats.nodesByType[type];
                else snap.stats.nodesByType[type] = next;
              }
              snapshotChanged = true;
            }
            if (snapshotChanged) {
              snap.updatedAt = new Date().toISOString();
              await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
            }
          }

          for (const tombstoneId of tombstonesToDelete) {
            await kv.delete(KV.graphTombstones, tombstoneId);
            clearedTombstones++;
          }
        });
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          deletedNodes,
          deletedEdges,
          skippedIndex,
          skippedStale,
          remaining: tombstones.length,
          tookMs: Date.now() - started,
        };
      }

      if (batch.length === 0) {
        return {
          success: true,
          deletedNodes: 0,
          deletedEdges: 0,
          skippedIndex: 0,
          skippedStale: 0,
          remaining: 0,
          tookMs: Date.now() - started,
        };
      }

      const remaining = Math.max(0, tombstones.length - clearedTombstones);
      const tookMs = Date.now() - started;
      await recordAudit(kv, "consolidate", "mem::graph-vacuum", [], {
        deletedNodes,
        deletedEdges,
        skippedIndex,
        skippedStale,
        remaining,
        tookMs,
      });
      logger.info("Graph vacuum pass", {
        deletedNodes,
        deletedEdges,
        skippedIndex,
        skippedStale,
        remaining,
        tookMs,
      });
      return {
        success: true,
        deletedNodes,
        deletedEdges,
        skippedIndex,
        skippedStale,
        remaining,
        tookMs,
      };
    },
  );

  // Operator-driven backlog cleanup: seed prune tombstones for a caller-supplied
  // set of orphan candidate ids (computed offline from a consistent snapshot, so
  // this never enumerates the heartbeat-fatal graphNodes/graphEdges scopes). Each
  // candidate is re-validated LIVE here (kept if it still has a source in the live
  // observation/memory set) and the tombstone records the current source count so
  // mem::graph-vacuum skips it if a later merge revives it. Backpressure: refuse
  // once graphTombstones exceeds tombstoneCeiling, since the vacuum lists it.
  sdk.registerFunction(
    "mem::graph-prune-orphans",
    async (data: {
      nodeIds?: string[];
      edgeIds?: string[];
      maxSeed?: number;
      tombstoneCeiling?: number;
    }) => {
      const requestedMaxSeed =
        typeof data?.maxSeed === "number" && Number.isFinite(data.maxSeed)
          ? data.maxSeed
          : 1000;
      const requestedCeiling =
        typeof data?.tombstoneCeiling === "number" &&
        Number.isFinite(data.tombstoneCeiling)
          ? data.tombstoneCeiling
          : 2000;
      const maxSeed = Math.floor(
        Math.max(1, Math.min(requestedMaxSeed, 5000)),
      );
      const tombstoneCeiling = Math.floor(Math.max(1, requestedCeiling));
      const nodeIds = Array.isArray(data?.nodeIds)
        ? data.nodeIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];
      const edgeIds = Array.isArray(data?.edgeIds)
        ? data.edgeIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];

      let queue: GraphTombstone[];
      try {
        queue = await kv.list<GraphTombstone>(KV.graphTombstones);
      } catch (err) {
        return {
          success: false,
          refused: true,
          reason: "tombstone queue unavailable",
          error: err instanceof Error ? err.message : String(err),
          seeded: 0,
          skippedLive: 0,
          skippedMissing: 0,
          remainingCandidates: nodeIds.length + edgeIds.length,
          tombstoneQueueLen: 0,
        };
      }
      if (queue.length >= tombstoneCeiling) {
        return {
          success: true,
          refused: true,
          reason:
            "tombstone queue at ceiling; drain via mem::graph-vacuum first",
          seeded: 0,
          skippedLive: 0,
          skippedMissing: 0,
          remainingCandidates: nodeIds.length + edgeIds.length,
          tombstoneQueueLen: queue.length,
        };
      }

      try {
        return await withKeyedLock("graph:merge", async () => {
          queue = await kv.list<GraphTombstone>(KV.graphTombstones);
          const availableCapacity = Math.max(
            0,
            tombstoneCeiling - queue.length,
          );
          if (availableCapacity === 0) {
            return {
              success: true,
              refused: true,
              reason:
                "tombstone queue at ceiling; drain via mem::graph-vacuum first",
              seeded: 0,
              skippedLive: 0,
              skippedMissing: 0,
              remainingCandidates: nodeIds.length + edgeIds.length,
              tombstoneQueueLen: queue.length,
            };
          }

          const liveSet = new Set<string>();
          try {
            const sessions = await kv.list<{ id?: string }>(KV.sessions);
            for (const session of sessions) {
              if (!session?.id) continue;
              const observations = await kv.list<{ id?: string }>(
                KV.observations(session.id),
              );
              for (const observation of observations) {
                if (observation?.id) liveSet.add(observation.id);
              }
            }
            const memories = await kv.list<{ id?: string }>(KV.memories);
            for (const memory of memories) {
              if (memory?.id) liveSet.add(memory.id);
            }
          } catch (err) {
            return {
              success: false,
              refused: true,
              reason: "live source enumeration failed",
              error: err instanceof Error ? err.message : String(err),
              seeded: 0,
              skippedLive: 0,
              skippedMissing: 0,
              remainingCandidates: nodeIds.length + edgeIds.length,
              tombstoneQueueLen: queue.length,
            };
          }

          const queuedIds = new Set(queue.map((tombstone) => tombstone.id));
          const seenCandidates = new Set<string>();
          const candidates: Array<{ id: string; kind: "node" | "edge" }> = [
            ...edgeIds.map((id) => ({ id, kind: "edge" as const })),
            ...nodeIds.map((id) => ({ id, kind: "node" as const })),
          ].filter((candidate) => {
            if (
              !candidate.id ||
              queuedIds.has(candidate.id) ||
              seenCandidates.has(candidate.id)
            ) {
              return false;
            }
            seenCandidates.add(candidate.id);
            return true;
          });
          const batch = candidates.slice(
            0,
            Math.min(maxSeed, availableCapacity),
          );
          const remainingCandidates = Math.max(
            0,
            candidates.length - batch.length,
          );
          let seeded = 0;
          let skippedLive = 0;
          let skippedMissing = 0;

          for (const candidate of batch) {
            if (candidate.kind === "edge") {
              const edge = await kv.get<GraphEdge>(
                KV.graphEdges,
                candidate.id,
              );
              if (!edge) {
                skippedMissing++;
                continue;
              }
              const sources = edge.sourceObservationIds ?? [];
              if (sources.some((source) => liveSet.has(source))) {
                const sourceNode = await kv.get<GraphNode>(
                  KV.graphNodes,
                  edge.sourceNodeId,
                );
                const sourceIsLive =
                  !!sourceNode &&
                  (sourceNode.sourceObservationIds ?? []).some((source) =>
                    liveSet.has(source),
                  );
                if (sourceIsLive) {
                  const targetNode = await kv.get<GraphNode>(
                    KV.graphNodes,
                    edge.targetNodeId,
                  );
                  const targetIsLive =
                    !!targetNode &&
                    (targetNode.sourceObservationIds ?? []).some((source) =>
                      liveSet.has(source),
                    );
                  if (targetIsLive) {
                    skippedLive++;
                    continue;
                  }
                }
              }
              await recordGraphTombstone(kv, {
                id: edge.id,
                kind: "edge",
                reason: "prune",
                indexKey: edgeIndexKey(
                  edge.sourceNodeId,
                  edge.targetNodeId,
                  edge.type,
                ),
                observedSourceIds: sources,
                edgeType: edge.type,
                sourceNodeId: edge.sourceNodeId,
                targetNodeId: edge.targetNodeId,
              });
              seeded++;
            } else {
              const node = await kv.get<GraphNode>(
                KV.graphNodes,
                candidate.id,
              );
              if (!node) {
                skippedMissing++;
                continue;
              }
              const sources = node.sourceObservationIds ?? [];
              if (sources.some((source) => liveSet.has(source))) {
                skippedLive++;
                continue;
              }
              await recordGraphTombstone(kv, {
                id: node.id,
                kind: "node",
                reason: "prune",
                indexKey: nameIndexKey(node.type, node.name),
                observedSourceIds: sources,
                nodeType: node.type,
              });
              seeded++;
            }
          }

          if (seeded > 0) {
            await recordAudit(
              kv,
              "consolidate",
              "mem::graph-prune-orphans",
              [],
              { seeded, skippedLive, skippedMissing, remainingCandidates },
            );
          }
          const tombstoneQueueLen = queue.length + seeded;
          logger.info("Graph prune-orphans seed pass", {
            seeded,
            skippedLive,
            skippedMissing,
            remainingCandidates,
            tombstoneQueueLen,
          });
          return {
            success: true,
            seeded,
            skippedLive,
            skippedMissing,
            remainingCandidates,
            tombstoneQueueLen,
          };
        });
      } catch (err) {
        return {
          success: false,
          refused: true,
          reason: "prune seed failed",
          error: err instanceof Error ? err.message : String(err),
          seeded: 0,
          skippedLive: 0,
          skippedMissing: 0,
          remainingCandidates: nodeIds.length + edgeIds.length,
          tombstoneQueueLen: queue.length,
        };
      }
    },
  );
}
