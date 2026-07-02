import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
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
  doomedBySignal: { stale: number; preReset: number; noLiveSource: number };
  forcedKeepNodes: number;
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

interface DoomSignals {
  doomed: boolean;
  stale: boolean;
  preReset: boolean;
  noLiveSource: boolean;
}

interface DoomableRow {
  stale?: boolean;
  createdAt: string;
  sourceObservationIds: string[];
}

function classifyRow(
  row: DoomableRow,
  liveSet: Set<string>,
  resetAt: string | undefined,
): DoomSignals {
  const stale = row.stale === true;
  const preReset = resetAt !== undefined && row.createdAt < resetAt;
  const noLiveSource = !row.sourceObservationIds.some((id) => liveSet.has(id));
  return {
    doomed: stale || preReset || noLiveSource,
    stale,
    preReset,
    noLiveSource,
  };
}

export function classifyGraph(input: ClassifyInput): ClassifyResult {
  const { nodes, edges, liveSet } = input;
  const resetAt = input.resetAt;
  const topN = input.topN ?? DEFAULT_TOP_N;

  const nodeById = new Map<string, GraphNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  const nodeSignals = new Map<string, DoomSignals>();
  for (const n of nodes) nodeSignals.set(n.id, classifyRow(n, liveSet, resetAt));

  const edgeSignals = new Map<string, DoomSignals>();
  const keptEdges: GraphEdge[] = [];
  for (const e of edges) {
    const sig = classifyRow(e, liveSet, resetAt);
    edgeSignals.set(e.id, sig);
    const bothEndpointsExist =
      nodeById.has(e.sourceNodeId) && nodeById.has(e.targetNodeId);
    if (!sig.doomed && bothEndpointsExist) keptEdges.push(e);
  }

  const keptNodeIds = new Set<string>();
  for (const n of nodes) {
    if (!nodeSignals.get(n.id)?.doomed) keptNodeIds.add(n.id);
  }
  for (const e of keptEdges) {
    keptNodeIds.add(e.sourceNodeId);
    keptNodeIds.add(e.targetNodeId);
  }

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

  const doomedBySignal = { stale: 0, preReset: 0, noLiveSource: 0 };
  const tally = (sig: DoomSignals | undefined): void => {
    if (!sig?.doomed) return;
    if (sig.stale) doomedBySignal.stale += 1;
    if (sig.preReset) doomedBySignal.preReset += 1;
    if (sig.noLiveSource) doomedBySignal.noLiveSource += 1;
  };
  for (const n of nodes) tally(nodeSignals.get(n.id));
  for (const e of edges) tally(edgeSignals.get(e.id));

  let forcedKeepNodes = 0;
  for (const n of nodes) {
    if (nodeSignals.get(n.id)?.doomed && keptNodeIds.has(n.id)) {
      forcedKeepNodes += 1;
    }
  }

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
    doomedBySignal,
    forcedKeepNodes,
  };

  return {
    report,
    manifest: { nodeIds: manifestNodeIds, edgeIds: manifestEdgeIds },
    prunedSnapshot,
  };
}

interface CliArgs {
  nodes?: string;
  edges?: string;
  obsDir?: string;
  memories?: string;
  resetAt?: string;
  top?: number;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
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
        const parsed = Number.parseInt(value ?? "", 10);
        if (!Number.isNaN(parsed)) args.top = parsed;
        i += 1;
        break;
      }
      case "--out":
        args.out = value;
        i += 1;
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

function readRows<T>(path: string): T[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, T>;
  return Object.values(parsed);
}

function collectLiveIds(
  obsDir: string | undefined,
  memoriesPath: string | undefined,
): Set<string> {
  const liveSet = new Set<string>();
  if (obsDir) {
    for (const file of readdirSync(obsDir)) {
      if (!file.endsWith(".bin")) continue;
      const parsed = JSON.parse(
        readFileSync(join(obsDir, file), "utf8"),
      ) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        liveSet.add(rowId(key, value));
      }
    }
  }
  if (memoriesPath) {
    const parsed = JSON.parse(readFileSync(memoriesPath, "utf8")) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(parsed)) {
      liveSet.add(rowId(key, value));
    }
  }
  return liveSet;
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  if (!args.nodes || !args.edges || !args.out) {
    console.error(
      "usage: prune-classify --nodes <path> --edges <path> --obs-dir <dir> --memories <path> [--reset-at <iso>] [--top <n>] --out <dir>",
    );
    process.exit(2);
    return;
  }

  const nodes = readRows<GraphNode>(args.nodes);
  const edges = readRows<GraphEdge>(args.edges);
  const liveSet = collectLiveIds(args.obsDir, args.memories);
  const result = classifyGraph({
    nodes,
    edges,
    liveSet,
    resetAt: args.resetAt,
    topN: args.top,
  });

  mkdirSync(args.out, { recursive: true });
  writeFileSync(
    join(args.out, "report.json"),
    JSON.stringify(result.report, null, 2),
  );
  writeFileSync(
    join(args.out, "manifest.json"),
    JSON.stringify(result.manifest, null, 2),
  );
  writeFileSync(
    join(args.out, "pruned-snapshot.json"),
    JSON.stringify(result.prunedSnapshot, null, 2),
  );
  console.log(JSON.stringify(result.report, null, 2));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
