import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  sourceObservationIds: string[];
  createdAt: string;
  updatedAt?: string;
  aliases?: string[];
  stale?: boolean;
}

export interface GraphEdge {
  id: string;
  type: string;
  sourceNodeId: string;
  targetNodeId: string;
  weight: number;
  sourceObservationIds: string[];
  createdAt: string;
  stale?: boolean;
}

export interface GraphSnapshot {
  version: 1;
  topNodes: GraphNode[];
  topEdges: GraphEdge[];
  topDegrees: Record<string, number>;
  stats: {
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
  };
  updatedAt: string;
  dirty: boolean;
  resetAt?: string;
}

export interface PruneReport {
  totalNodes: number;
  totalEdges: number;
  keptNodes: number;
  keptEdges: number;
  doomedNodes: number;
  doomedEdges: number;
  nodeSignals: { stale: number; noLiveSource: number };
  edgeSignals: {
    stale: number;
    noLiveSource: number;
    dangling: number;
    endpointNotRelevant: number;
  };
}

export interface ClassifyInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  liveSet: Set<string>;
  resetAt?: string;
  topN?: number;
}

export interface ClassifyResult {
  report: PruneReport;
  manifest: { nodeIds: string[]; edgeIds: string[] };
  prunedSnapshot: GraphSnapshot;
}

const DEFAULT_TOP_N = 500;
const NEAR_TOTAL_PRUNE_RATIO = 0.9;

// Relevance is reachability from live data: a node is relevant when it is not
// stale and at least one of its source observation ids is still in the live set
// (live observation ids plus live memory ids). The pre-reset timestamp is NOT a
// delete signal, so a pre-reset row still connected to live observations is kept.
export function classifyGraph(input: ClassifyInput): ClassifyResult {
  const { nodes, edges, liveSet } = input;
  const resetAt = input.resetAt;
  const topN = input.topN ?? DEFAULT_TOP_N;

  const nodeById = new Map<string, GraphNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  const relevantNodeIds = new Set<string>();
  let staleNodes = 0;
  let noLiveSourceNodes = 0;
  for (const n of nodes) {
    if (n.stale === true) {
      staleNodes += 1;
      continue;
    }
    if (n.sourceObservationIds.some((id) => liveSet.has(id))) {
      relevantNodeIds.add(n.id);
    } else {
      noLiveSourceNodes += 1;
    }
  }

  // A relevant edge is not stale, reachable from a live source, and has BOTH
  // endpoints among the relevant nodes. This drops dangling edges (missing
  // endpoint) and edges whose endpoint is itself an orphan, so the kept graph is
  // referentially closed by construction (no kept edge points at a pruned node).
  const keptEdges: GraphEdge[] = [];
  const edgeSignals = {
    stale: 0,
    noLiveSource: 0,
    dangling: 0,
    endpointNotRelevant: 0,
  };
  for (const e of edges) {
    if (e.stale === true) {
      edgeSignals.stale += 1;
      continue;
    }
    if (!e.sourceObservationIds.some((id) => liveSet.has(id))) {
      edgeSignals.noLiveSource += 1;
      continue;
    }
    if (!nodeById.has(e.sourceNodeId) || !nodeById.has(e.targetNodeId)) {
      edgeSignals.dangling += 1;
      continue;
    }
    if (
      !relevantNodeIds.has(e.sourceNodeId) ||
      !relevantNodeIds.has(e.targetNodeId)
    ) {
      edgeSignals.endpointNotRelevant += 1;
      continue;
    }
    keptEdges.push(e);
  }

  const keptNodeIds = relevantNodeIds;
  const keptEdgeIds = new Set(keptEdges.map((e) => e.id));
  const manifestEdgeIds = edges
    .filter((e) => !keptEdgeIds.has(e.id))
    .map((e) => e.id);
  const manifestNodeIds = nodes
    .filter((n) => !keptNodeIds.has(n.id))
    .map((n) => n.id);

  const prunedNodeIds = new Set(manifestNodeIds);
  for (const e of keptEdges) {
    if (prunedNodeIds.has(e.sourceNodeId) || prunedNodeIds.has(e.targetNodeId)) {
      throw new Error(
        `Referential closure violated: kept edge ${e.id} references a pruned node`,
      );
    }
  }

  const keptNodes = nodes.filter((n) => keptNodeIds.has(n.id));

  const degree = new Map<string, number>();
  for (const e of keptEdges) {
    degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
    degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
  }

  const topNodes = [...keptNodes]
    .sort((a, b) => {
      const byDegree = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
      if (byDegree !== 0) return byDegree;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, topN);
  const topNodeIds = new Set(topNodes.map((n) => n.id));
  const topEdges = keptEdges.filter(
    (e) => topNodeIds.has(e.sourceNodeId) && topNodeIds.has(e.targetNodeId),
  );
  const topDegrees: Record<string, number> = {};
  for (const n of topNodes) topDegrees[n.id] = degree.get(n.id) ?? 0;

  const nodesByType: Record<string, number> = {};
  for (const n of keptNodes) nodesByType[n.type] = (nodesByType[n.type] ?? 0) + 1;
  const edgesByType: Record<string, number> = {};
  for (const e of keptEdges) edgesByType[e.type] = (edgesByType[e.type] ?? 0) + 1;

  const prunedSnapshot: GraphSnapshot = {
    version: 1,
    topNodes,
    topEdges,
    topDegrees,
    stats: {
      totalNodes: keptNodeIds.size,
      totalEdges: keptEdges.length,
      nodesByType,
      edgesByType,
    },
    updatedAt: new Date().toISOString(),
    dirty: false,
    resetAt,
  };

  const report: PruneReport = {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    keptNodes: keptNodeIds.size,
    keptEdges: keptEdges.length,
    doomedNodes: manifestNodeIds.length,
    doomedEdges: manifestEdgeIds.length,
    nodeSignals: { stale: staleNodes, noLiveSource: noLiveSourceNodes },
    edgeSignals,
  };

  return {
    report,
    manifest: { nodeIds: manifestNodeIds, edgeIds: manifestEdgeIds },
    prunedSnapshot,
  };
}

export interface CliArgs {
  nodes?: string;
  edges?: string;
  obsDir?: string;
  memories?: string;
  resetAt?: string;
  top?: number;
  out?: string;
  allowEmptyLiveSet?: boolean;
  allowNearTotalPrune?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--nodes":
        args.nodes = value;
        i += 1;
        break;
      case "--edges":
        args.edges = value;
        i += 1;
        break;
      case "--obs-dir":
        args.obsDir = value;
        i += 1;
        break;
      case "--memories":
        args.memories = value;
        i += 1;
        break;
      case "--reset-at":
        args.resetAt = value;
        i += 1;
        break;
      case "--top": {
        if (!value || !/^[1-9]\d*$/.test(value)) {
          throw new Error("--top must be a positive integer");
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) {
          throw new Error("--top must be a positive integer");
        }
        args.top = parsed;
        i += 1;
        break;
      }
      case "--out":
        args.out = value;
        i += 1;
        break;
      case "--allow-empty-live-set":
        args.allowEmptyLiveSet = true;
        break;
      case "--allow-near-total-prune":
        args.allowNearTotalPrune = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function rowId(key: string, value: unknown): string {
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return key;
}

// The iii file-based KV persists each scope as a JSON object followed by a
// binary integrity trailer, so a whole-file JSON.parse fails on the trailer.
// Scan byte-wise to the end of the top-level object (JSON structural bytes are
// single-byte ASCII, never a UTF-8 continuation byte) and parse just that.
export function parseBinObject(buf: Buffer): Record<string, unknown> {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let started = false;
  let end = -1;
  for (let i = 0; i < buf.length; i += 1) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true;
      else if (c === 0x22) inStr = false;
      continue;
    }
    if (c === 0x22) inStr = true;
    else if (c === 0x7b) {
      depth += 1;
      started = true;
    } else if (c === 0x7d) {
      depth -= 1;
      if (started && depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("no balanced top-level JSON object");
  return JSON.parse(buf.subarray(0, end + 1).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function readRows<T>(path: string): T[] {
  const parsed = parseBinObject(readFileSync(path));
  return Object.values(parsed) as T[];
}

function collectLiveIds(
  obsDir: string | undefined,
  memoriesPath: string | undefined,
): Set<string> {
  const liveSet = new Set<string>();
  if (obsDir) {
    for (const file of readdirSync(obsDir)) {
      if (!file.endsWith(".bin")) continue;
      const parsed = parseBinObject(readFileSync(join(obsDir, file)));
      for (const [key, value] of Object.entries(parsed)) {
        liveSet.add(rowId(key, value));
      }
    }
  }
  if (memoriesPath) {
    const parsed = parseBinObject(readFileSync(memoriesPath));
    for (const [key, value] of Object.entries(parsed)) {
      liveSet.add(rowId(key, value));
    }
  }
  return liveSet;
}

function assertSafePrune(
  result: ClassifyResult,
  allowNearTotalPrune: boolean,
): void {
  if (allowNearTotalPrune) return;

  const totalRows = result.report.totalNodes + result.report.totalEdges;
  const keptRows = result.report.keptNodes + result.report.keptEdges;
  if (totalRows === 0 || keptRows === 0) {
    throw new Error(
      "prune would produce an empty graph; rerun with --allow-near-total-prune after verifying inputs",
    );
  }

  const pruneRatios: Array<[string, number]> = [
    [
      "nodes",
      result.report.totalNodes === 0
        ? 0
        : result.report.doomedNodes / result.report.totalNodes,
    ],
    [
      "edges",
      result.report.totalEdges === 0
        ? 0
        : result.report.doomedEdges / result.report.totalEdges,
    ],
  ];
  for (const [resource, pruneRatio] of pruneRatios) {
    if (pruneRatio >= NEAR_TOTAL_PRUNE_RATIO) {
      throw new Error(
        `prune would remove ${(pruneRatio * 100).toFixed(1)}% of ${resource}; rerun with --allow-near-total-prune after verifying inputs`,
      );
    }
  }
}

function writeOutputsAtomically(
  outDir: string,
  result: ClassifyResult,
): void {
  mkdirSync(outDir, { recursive: true });
  const outputs: Array<[string, unknown]> = [
    ["report.json", result.report],
    ["manifest.json", result.manifest],
    ["pruned-snapshot.json", result.prunedSnapshot],
  ];
  const pending = outputs.map(([name, value]) => ({
    target: join(outDir, name),
    temporary: join(outDir, `.${name}.${process.pid}.${randomUUID()}.tmp`),
    contents: JSON.stringify(value, null, 2),
  }));

  try {
    for (const output of pending) {
      writeFileSync(output.temporary, output.contents, { flag: "wx" });
    }
    for (const output of pending) {
      renameSync(output.temporary, output.target);
    }
  } finally {
    for (const output of pending) rmSync(output.temporary, { force: true });
  }
}

export function runPruneClassifier(argv: string[]): ClassifyResult {
  const args = parseArgs(argv);
  if (!args.nodes || !args.edges || !args.out) {
    throw new Error(
      "usage: prune-classify --nodes <path> --edges <path> --obs-dir <dir> --memories <path> [--reset-at <iso>] [--top <n>] [--allow-empty-live-set] [--allow-near-total-prune] --out <dir>",
    );
  }
  if ((!args.obsDir || !args.memories) && !args.allowEmptyLiveSet) {
    throw new Error(
      "--obs-dir and --memories are required live-source inputs; use --allow-empty-live-set only after verifying an incomplete source set is intentional",
    );
  }

  const nodes = readRows<GraphNode>(args.nodes);
  const edges = readRows<GraphEdge>(args.edges);
  const liveSet = collectLiveIds(args.obsDir, args.memories);
  if (liveSet.size === 0 && !args.allowEmptyLiveSet) {
    throw new Error(
      "live-source inputs contain no IDs; use --allow-empty-live-set only after verifying this is intentional",
    );
  }
  const result = classifyGraph({
    nodes,
    edges,
    liveSet,
    resetAt: args.resetAt,
    topN: args.top,
  });

  assertSafePrune(result, args.allowNearTotalPrune === true);
  writeOutputsAtomically(args.out, result);
  return result;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    const result = runPruneClassifier(process.argv.slice(2));
    console.log(JSON.stringify(result.report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
