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
import { KV, generateId } from "../state/schema.js";
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

// #753: keep the response payload below the iii state channel ceiling.
// 500 nodes + their incident edges hold well under the limit on the
// reported 11k-node / 28k-edge corpus, and 5,000 is the upper bound a
// caller can request explicitly. Tuned conservatively because edges
// fan out faster than nodes.
const DEFAULT_GRAPH_QUERY_LIMIT = 500;
const MAX_GRAPH_QUERY_LIMIT = 5000;

// #814: the precomputed snapshot covers the top-degree subgraph used by
// the empty-body / nodeType-only branch — the path the viewer hits on
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
  const raw = process.env.AGENTMEMORY_GRAPH_EXTRACT_TIMEOUT_MS;
  if (!raw) return GRAPH_EXTRACT_TIMEOUT_MS_DEFAULT;
  const n = parseInt(raw, 10);
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
  const raw = process.env.GRAPH_CHUNK_SIZE;
  if (!raw) return GRAPH_CHUNK_SIZE_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : GRAPH_CHUNK_SIZE_DEFAULT;
}

export function getGraphChunkConcurrency(): number {
  const raw = process.env.GRAPH_CHUNK_CONCURRENCY;
  if (!raw) return GRAPH_CHUNK_CONCURRENCY_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : GRAPH_CHUNK_CONCURRENCY_DEFAULT;
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

function buildSnapshotFromArrays(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphSnapshot {
  const liveNodes = nodes.filter((n) => !n.stale);
  const liveEdges = edges.filter((e) => !e.stale);
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
// snapshot's recorded `totalNodes` already exceeds this threshold —
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

// Queue a doomed row for physical deletion by mem::graph-vacuum. Keyed by the
// doomed id so re-recording is idempotent. Callers own any logical bookkeeping
// (stats/degree/topN) BEFORE recording; the vacuum is a pure physical delete.
export async function recordGraphTombstone(
  kv: StateKV,
  entry: {
    id: string;
    kind: "node" | "edge";
    reason: "cascade" | "orphan" | "retention" | "prune";
    indexKey: string;
    observedSourceCount?: number;
  },
): Promise<void> {
  const tombstone: GraphTombstone = {
    ...entry,
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
    // Capacity available — fetch + promote.
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
        if (process.env.AGENTMEMORY_GRAPH_RETENTION_CAP === "true") {
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
  // when BOTH endpoints land in the page — half-edges to nodes outside
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

// Parse all key="value" pairs from a tag's attribute string, in any
// order. The previous parser hard-coded attribute order
// (type before name on <entity>, type/source/target/weight on
// <relationship>) and silently dropped nodes/edges when the upstream
// LLM emitted attributes in a different order — Codex in particular
// likes to lead with `name=` (#635).
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
    const type = attrs["type"] as GraphNode["type"] | undefined;
    const name = attrs["name"];
    if (!type || !name || !GRAPH_NODE_TYPE_SET.has(type)) return;
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
  // #814 v2: targeted name-index lookups replace the O(n) scan over the full
  // graphNodes scope, whose multi-MB list payload starved the iii heartbeat at
  // ~75K nodes. The caller wraps this whole read-modify-write of the shared
  // snapshot in withKeyedLock("graph:merge") so concurrent extracts under the
  // consolidation pool cannot lose snapshot stat or topNode updates.
  const snap = (await readGraphSnapshot(kv)) ?? emptySnapshot();
  const capturedAt = new Date().toISOString();
  let newNodeCount = 0;
  let newEdgeCount = 0;
  const newEdgesForTopCheck: GraphEdge[] = [];

  for (const node of nodes) {
    const indexKey = nameIndexKey(node.type, node.name);
    const existingId = await kv.get<string>(KV.graphNameIndex, indexKey);

    let existing: GraphNode | null = null;
    if (existingId) {
      existing = await kv.get<GraphNode>(KV.graphNodes, existingId);
      // #825: drop pre-reset rows so extract writes a fresh node + index entry
      // instead of reconnecting to a legacy orphan (which pins the snapshot at 0).
      if (
        existing &&
        snap.resetAt &&
        typeof existing.createdAt === "string" &&
        existing.createdAt < snap.resetAt
      ) {
        // Orphan predates the last reset: queue the legacy row for deletion
        // (no stat decrement - it was never counted in the post-reset epoch).
        await recordGraphTombstone(kv, {
          id: existingId,
          kind: "node",
          reason: "orphan",
          indexKey,
        });
        existing = null;
      }
    }

    if (existing) {
      const merged = mergeNode(existing, node, node.sourceObservationIds, capturedAt);
      await kv.set(KV.graphNodes, existing.id, merged);
      const topIdx = snap.topNodes.findIndex((n) => n.id === existing!.id);
      if (topIdx !== -1) snap.topNodes[topIdx] = merged;
    } else {
      await kv.set(KV.graphNodes, node.id, node);
      await kv.set(KV.graphNameIndex, indexKey, node.id);
      await kv.set(KV.graphNodeDegree, node.id, 0);
      snap.stats.totalNodes += 1;
      snap.stats.nodesByType[node.type] =
        (snap.stats.nodesByType[node.type] ?? 0) + 1;
      newNodeCount += 1;
      if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
        snap.topNodes.push(node);
        snap.topDegrees[node.id] = 0;
      }
    }
  }

  for (const edge of edges) {
    const eKey = edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type);
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
        });
        existing = null;
      }
    }

    if (existing) {
      const merged = mergeEdge(existing, edge.sourceObservationIds);
      await kv.set(KV.graphEdges, existing.id, merged);
      const topIdx = snap.topEdges.findIndex((e) => e.id === existing!.id);
      if (topIdx !== -1) snap.topEdges[topIdx] = merged;
    } else {
      await kv.set(KV.graphEdges, edge.id, edge);
      await kv.set(KV.graphEdgeKey, eKey, edge.id);
      snap.stats.totalEdges += 1;
      snap.stats.edgesByType[edge.type] =
        (snap.stats.edgesByType[edge.type] ?? 0) + 1;
      newEdgeCount += 1;
      await applyDegreeDelta(kv, snap, edge.sourceNodeId, +1);
      await applyDegreeDelta(kv, snap, edge.targetNodeId, +1);
      newEdgesForTopCheck.push(edge);
    }
  }

  for (const edge of newEdgesForTopCheck) {
    snapshotPushEdgeIfBothInTop(snap, edge);
  }

  if (newNodeCount > 0 || newEdgeCount > 0) {
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
            return { success: false, error: "all_chunks_failed" };
          }
          if (skipped > 0) {
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
        });

        logger.info("Graph extraction complete", {
          nodes: nodes.length,
          edges: edges.length,
          newNodes: newNodeCount,
          newEdges: newEdgeCount,
        });
        return {
          success: true,
          nodesAdded: nodes.length,
          edgesAdded: edges.length,
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
            "extracted yet, or you are on a legacy corpus from a pre-#814 " +
            "agentmemory build. Run POST /agentmemory/graph/snapshot-rebuild " +
            "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to " +
            "wipe and let future extracts repopulate.",
        };
      }

      // The query and startNodeId paths previously enumerated the full
      // graph via kv.list. On a large corpus that serializes a multi-MB
      // state frame and starves the single-threaded iii worker heartbeat;
      // the soft withTimeout rejects the promise but cannot abort the
      // serialization, so the worker reconnects and the caller sees a 500.
      // Both paths now read the bounded snapshot exclusively, matching
      // graph-stats, the noWalk branch, and graph-retrieval.ts.
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
            "extracted yet, or you are on a legacy corpus from a pre-#814 " +
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
  // endpoints — never a 500.
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
  // kv.list — the same pair that breaks at 75K+ — so we refuse to
  // run on corpora large enough that the response payload would
  // block the worker heartbeat. Above the ceiling the only safe path
  // is mem::graph-reset followed by incremental re-extraction.
  sdk.registerFunction(
    "mem::graph-snapshot-rebuild",
    async (data?: { force?: boolean }) => {
      const started = Date.now();
      // #825: pre-flight refusal for legacy corpora. The old guard
      // checked node count AFTER kv.list, but the heartbeat dies at
      // ~0.35s on a 75K-node response — long before the wall-clock
      // budget can fire. We can't safely enumerate to discover size.
      //
      // Heuristic: if no snapshot exists, the corpus is either empty
      // or legacy. The empty case has nothing to rebuild; the legacy
      // case will crash. Refuse both unless `force: true` is passed
      // (operator opt-in to attempt rebuild on a corpus they know is
      // small enough — typically under 10K nodes on the default iii
      // state adapter).
      // Strict boolean check on force — accept only literal `true`,
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
      // writes via Promise.all to avoid N sequential round-trips —
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

  // #814 v2 + #825: clean-restart escape hatch for corpora of any
  // size, including the legacy 75K+ case that crashes kv.list.
  //
  // Previous reset walked kv.list<GraphNode/Edge>(...) which is the
  // exact primitive that heartbeat-crashes the worker on the corpus
  // this reset was meant to recover (Allan's repro, 0.35s death).
  //
  // The new design is enumeration-free: write an empty snapshot and
  // return. The hot path (mem::graph-query empty-body, mem::graph-stats)
  // reads ONLY the snapshot post-#816, so a fresh empty snapshot
  // makes the graph behave as if it were empty for every read.
  //
  // Future extracts repopulate the snapshot + side-indexes
  // incrementally (graph-extract is O(1) per node post-#816 — it does
  // not consult the legacy rows).
  //
  // Trade-off: legacy rows in KV.graphNodes / KV.graphEdges remain on
  // disk as unreferenced orphans. They consume disk but are never
  // read by any post-#816 code path. Cleanup is deferred to a future
  // chunked-vacuum job; #816's broken vacuum-via-list strategy is
  // what we are leaving behind here.
  sdk.registerFunction("mem::graph-reset", async () => {
    const started = Date.now();
    // Stamp resetAt=now on the empty snapshot. Future
    // mem::graph-extract calls compare each name-index lookup's
    // existing node `createdAt` against this timestamp; anything
    // older counts as an orphan and is dropped from the merge path,
    // forcing extract to write a fresh row instead of reconnecting
    // to a pre-reset entry.
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

  // Physical-delete pass for the graph pruning queue. Reads the bounded
  // KV.graphTombstones scope (the ONLY kv.list here, and it stays a tiny
  // frame because it is drained faster than produced) and deletes up to
  // `budget` doomed rows from graphNodes/graphEdges plus their side-index
  // entries. Runs under the graph:merge lock so a concurrent extract cannot
  // resurrect a row this pass deletes. All logical bookkeeping (stats,
  // degree, topN) already happened when the tombstone was recorded, so this
  // pass is a pure physical delete.
  sdk.registerFunction(
    "mem::graph-vacuum",
    async (data?: { budget?: number }) => {
      const DEFAULT_BUDGET = 300;
      const MAX_BUDGET = 5000;
      const envRaw = process.env.AGENTMEMORY_GRAPH_VACUUM_BUDGET;
      const envParsed = envRaw ? parseInt(envRaw, 10) : DEFAULT_BUDGET;
      const envBudget =
        Number.isFinite(envParsed) && envParsed > 0 ? envParsed : DEFAULT_BUDGET;
      const budget = Math.max(1, Math.min(data?.budget ?? envBudget, MAX_BUDGET));

      const started = Date.now();
      const tombstones = await kv
        .list<GraphTombstone>(KV.graphTombstones)
        .catch(() => [] as GraphTombstone[]);
      const batch = tombstones.slice(0, budget);
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

      let deletedNodes = 0;
      let deletedEdges = 0;
      let skippedIndex = 0;
      let skippedStale = 0;

      await withKeyedLock("graph:merge", async () => {
        for (const t of batch) {
          if (!t || typeof t.id !== "string") continue;
          // Prune freshness guard: a row doomed by the offline sweep may have
          // gained a live source via a later merge. observedSourceCount is the
          // source count captured at seed time; if the live row's count has
          // since changed, the row is no longer that orphan, so drop the
          // tombstone without deleting.
          if (typeof t.observedSourceCount === "number") {
            const scope = t.kind === "edge" ? KV.graphEdges : KV.graphNodes;
            const cur = await kv.get<{ sourceObservationIds?: string[] }>(
              scope,
              t.id,
            );
            if (
              cur &&
              (cur.sourceObservationIds?.length ?? 0) !== t.observedSourceCount
            ) {
              await kv.delete(KV.graphTombstones, t.id);
              skippedStale++;
              continue;
            }
          }
          if (t.kind === "edge") {
            await kv.delete(KV.graphEdges, t.id);
            // Verify-then-delete: only drop the edge-key entry if it still
            // resolves to this doomed id. A newer extract may have recreated
            // the same source|target|type and repointed it to a live edge.
            if (t.indexKey) {
              const cur = await kv.get<string>(KV.graphEdgeKey, t.indexKey);
              if (cur === t.id) await kv.delete(KV.graphEdgeKey, t.indexKey);
              else skippedIndex++;
            }
            deletedEdges++;
          } else {
            await kv.delete(KV.graphNodes, t.id);
            // Degree is keyed by this dead node id, so dropping it is always
            // safe (a re-extracted node gets a fresh id).
            await kv.delete(KV.graphNodeDegree, t.id);
            if (t.indexKey) {
              const cur = await kv.get<string>(KV.graphNameIndex, t.indexKey);
              if (cur === t.id) await kv.delete(KV.graphNameIndex, t.indexKey);
              else skippedIndex++;
            }
            deletedNodes++;
          }
          await kv.delete(KV.graphTombstones, t.id);
        }
      });

      const remaining = Math.max(0, tombstones.length - batch.length);
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
      const maxSeed = Math.max(1, Math.min(data?.maxSeed ?? 1000, 5000));
      const tombstoneCeiling = Math.max(1, data?.tombstoneCeiling ?? 2000);
      const nodeIds = Array.isArray(data?.nodeIds) ? data.nodeIds : [];
      const edgeIds = Array.isArray(data?.edgeIds) ? data.edgeIds : [];

      const queue = await kv
        .list<GraphTombstone>(KV.graphTombstones)
        .catch(() => [] as GraphTombstone[]);
      if (queue.length > tombstoneCeiling) {
        return {
          success: true,
          refused: true,
          reason:
            "tombstone queue above ceiling; drain via mem::graph-vacuum first",
          seeded: 0,
          skippedLive: 0,
          skippedMissing: 0,
          remainingCandidates: nodeIds.length + edgeIds.length,
          tombstoneQueueLen: queue.length,
        };
      }

      const liveSet = new Set<string>();
      const sessions = await kv
        .list<{ id?: string }>(KV.sessions)
        .catch(() => [] as { id?: string }[]);
      for (const s of sessions) {
        if (!s?.id) continue;
        const obs = await kv
          .list<{ id?: string }>(KV.observations(s.id))
          .catch(() => [] as { id?: string }[]);
        for (const o of obs) if (o?.id) liveSet.add(o.id);
      }
      const memories = await kv
        .list<{ id?: string }>(KV.memories)
        .catch(() => [] as { id?: string }[]);
      for (const m of memories) if (m?.id) liveSet.add(m.id);

      const candidates: Array<{ id: string; kind: "node" | "edge" }> = [
        ...edgeIds.map((id) => ({ id, kind: "edge" as const })),
        ...nodeIds.map((id) => ({ id, kind: "node" as const })),
      ];
      const batch = candidates.slice(0, maxSeed);
      const remainingCandidates = Math.max(0, candidates.length - batch.length);

      let seeded = 0;
      let skippedLive = 0;
      let skippedMissing = 0;

      for (const c of batch) {
        if (c.kind === "edge") {
          const e = await kv.get<GraphEdge>(KV.graphEdges, c.id);
          if (!e) {
            skippedMissing++;
            continue;
          }
          const sources = e.sourceObservationIds ?? [];
          // Keep (skip) an edge only if it is fully relevant: a live source AND
          // both endpoints still exist as live nodes. A dangling edge (missing
          // endpoint) or an orphan-endpoint edge is trash even when its own obs
          // are live, so it must fall through to be tombstoned.
          if (sources.some((s) => liveSet.has(s))) {
            const src = await kv.get<GraphNode>(KV.graphNodes, e.sourceNodeId);
            const srcLive =
              !!src && (src.sourceObservationIds ?? []).some((s) => liveSet.has(s));
            if (srcLive) {
              const tgt = await kv.get<GraphNode>(KV.graphNodes, e.targetNodeId);
              const tgtLive =
                !!tgt &&
                (tgt.sourceObservationIds ?? []).some((s) => liveSet.has(s));
              if (tgtLive) {
                skippedLive++;
                continue;
              }
            }
          }
          await recordGraphTombstone(kv, {
            id: e.id,
            kind: "edge",
            reason: "prune",
            indexKey: edgeIndexKey(e.sourceNodeId, e.targetNodeId, e.type),
            observedSourceCount: sources.length,
          });
          seeded++;
        } else {
          const n = await kv.get<GraphNode>(KV.graphNodes, c.id);
          if (!n) {
            skippedMissing++;
            continue;
          }
          const sources = n.sourceObservationIds ?? [];
          if (sources.some((s) => liveSet.has(s))) {
            skippedLive++;
            continue;
          }
          await recordGraphTombstone(kv, {
            id: n.id,
            kind: "node",
            reason: "prune",
            indexKey: nameIndexKey(n.type, n.name),
            observedSourceCount: sources.length,
          });
          seeded++;
        }
      }

      if (seeded > 0) {
        await recordAudit(kv, "consolidate", "mem::graph-prune-orphans", [], {
          seeded,
          skippedLive,
          skippedMissing,
          remainingCandidates,
        });
      }
      logger.info("Graph prune-orphans seed pass", {
        seeded,
        skippedLive,
        skippedMissing,
        remainingCandidates,
        tombstoneQueueLen: queue.length,
      });
      return {
        success: true,
        seeded,
        skippedLive,
        skippedMissing,
        remainingCandidates,
        tombstoneQueueLen: queue.length,
      };
    },
  );
}
