/// <reference types="node" />

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { LocalEmbeddingProvider } from "../src/providers/embedding/local.js";
import { buildSnapshotFromArrays } from "../src/functions/graph.js";
import { extractEntitiesFromQuery } from "../src/functions/query-expansion.js";
import { KV } from "../src/state/schema.js";
import { SNAPSHOT_KEY } from "../src/state/graph-snapshot.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
} from "../src/types.js";
import {
  BENCHMARK_DATASET_VERSION,
  generateDataset,
  type GraphBenchmarkLink,
  type LabeledQuery,
} from "./dataset.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  let snapshotReads = 0;
  let snapshotWrites = 0;
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      if (scope === KV.graphSnapshot && key === SNAPSHOT_KEY) snapshotReads++;
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      if (scope === KV.graphSnapshot && key === SNAPSHOT_KEY) snapshotWrites++;
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
    snapshotReads: () => snapshotReads,
    snapshotWrites: () => snapshotWrites,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function obsToText(obs: CompressedObservation): string {
  return [obs.title, obs.subtitle || "", obs.narrative, ...obs.facts, ...obs.concepts].join(" ");
}

function recall(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1;
  const topK = new Set(retrieved.slice(0, k));
  let hits = 0;
  for (const id of relevant) if (topK.has(id)) hits++;
  return hits / relevant.size;
}

function precision(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0) return 0;
  let hits = 0;
  for (const id of topK) if (relevant.has(id)) hits++;
  return hits / topK.length;
}

function dcg(relevances: boolean[], k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, relevances.length); i++)
    sum += (relevances[i] ? 1 : 0) / Math.log2(i + 2);
  return sum;
}

function ndcg(retrieved: string[], relevant: Set<string>, k: number): number {
  const actual = retrieved.slice(0, k).map(id => relevant.has(id));
  const ideal = Array.from({ length: Math.min(k, relevant.size) }, () => true);
  const idealDCG = dcg(ideal, k);
  return idealDCG === 0 ? 0 : dcg(actual, k) / idealDCG;
}

function mrr(retrieved: string[], relevant: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++)
    if (relevant.has(retrieved[i])) return 1 / (i + 1);
  return 0;
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

interface QueryResult {
  query: string;
  category: string;
  recall_5: number;
  recall_10: number;
  precision_5: number;
  ndcg_10: number;
  mrr_val: number;
  relevant_count: number;
  latency_ms: number;
  retrieved_ids: string[];
  returned_tokens: number;
}

interface SystemResult {
  name: string;
  results: QueryResult[];
  embed_time_ms: number;
  tokens_per_query: number;
  snapshot_reads: number;
  snapshot_writes: number;
  snapshot_nodes: number;
  snapshot_edges: number;
  graph_search_enabled: boolean;
}

interface EvalSystemOptions {
  name: string;
  observations: CompressedObservation[];
  queries: LabeledQuery[];
  provider: EmbeddingProvider | null;
  weights: { bm25: number; vector: number; graph: number };
  graphSnapshot?: GraphSnapshot;
  graphSearchEnabled?: boolean;
}

interface GraphValidityEvidence {
  proof: GraphBenchmarkLink;
  dualIds: string[];
  tripleIds: string[];
  connectedProbeHits: number;
  recallDelta: number;
  zeroEntityQuery: string;
  zeroEntityIds: string[];
}

function buildBenchmarkGraphSnapshot(
  observations: CompressedObservation[],
  graphLinks: GraphBenchmarkLink[],
): GraphSnapshot {
  const observationsById = new Map(
    observations.map((observation) => [observation.id, observation]),
  );
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const [index, link] of graphLinks.entries()) {
    const anchor = observationsById.get(link.anchorObsId);
    const target = observationsById.get(link.graphOnlyObsId);
    assert(anchor, `Missing graph anchor observation ${link.anchorObsId}`);
    assert(target, `Missing graph target observation ${link.graphOnlyObsId}`);
    const suffix = index.toString().padStart(2, "0");
    const anchorNodeId = `gn_benchmark_anchor_${suffix}`;
    const targetNodeId = `gn_benchmark_target_${suffix}`;
    nodes.push(
      {
        id: anchorNodeId,
        type: "project",
        name: link.anchorEntity,
        properties: { fixture: BENCHMARK_DATASET_VERSION },
        sourceObservationIds: [anchor.id],
        createdAt: anchor.timestamp,
      },
      {
        id: targetNodeId,
        type: "concept",
        name: link.targetNodeName,
        properties: { fixture: BENCHMARK_DATASET_VERSION },
        sourceObservationIds: [target.id],
        createdAt: target.timestamp,
      },
    );
    edges.push({
      id: `ge_benchmark_${suffix}`,
      type: "related_to",
      sourceNodeId: anchorNodeId,
      targetNodeId,
      weight: 1,
      sourceObservationIds: [anchor.id, target.id],
      createdAt: target.timestamp,
      context: {
        reasoning: `Synthetic gold link for ${link.query}`,
        confidence: 1,
      },
    });
  }

  return buildSnapshotFromArrays(nodes, edges);
}

async function evalSystem(options: EvalSystemOptions): Promise<SystemResult> {
  const {
    name,
    observations,
    queries,
    provider,
    weights,
    graphSnapshot,
    graphSearchEnabled = false,
  } = options;
  const kv = mockKV();
  const bm25 = new SearchIndex();
  const vector = provider ? new VectorIndex() : null;

  console.log(`  Indexing ${observations.length} observations...`);
  const embedStart = performance.now();

  for (const obs of observations) {
    bm25.add(obs);
    await kv.set(`mem:obs:${obs.sessionId}`, obs.id, obs);
  }

  if (graphSnapshot) {
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, graphSnapshot);
  }

  if (provider && vector) {
    const batchSize = 32;
    for (let i = 0; i < observations.length; i += batchSize) {
      const batch = observations.slice(i, i + batchSize);
      const texts = batch.map(o => obsToText(o));
      const embeddings = await provider.embedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        vector.add(batch[j].id, batch[j].sessionId, embeddings[j]);
      }
      if ((i + batchSize) % 100 === 0 || i + batchSize >= observations.length) {
        process.stdout.write(`\r  Embedded ${Math.min(i + batchSize, observations.length)}/${observations.length}`);
      }
    }
    console.log("");
  }

  const embedTime = performance.now() - embedStart;

  const hybrid = new HybridSearch(
    bm25,
    vector,
    provider,
    kv as never,
    weights.bm25,
    weights.vector,
    weights.graph,
    false,
    graphSearchEnabled,
  );

  console.log(`  Running ${queries.length} queries...`);
  const results: QueryResult[] = [];

  for (const q of queries) {
    const relevant = new Set(q.relevantObsIds);
    const start = performance.now();
    const searchResults = await hybrid.search(q.query, 20);
    const latency = performance.now() - start;

    const retrieved = searchResults.map(r => r.observation.id);
    const returnedTokens = searchResults
      .slice(0, 10)
      .reduce(
        (sum, result) => sum + estimateTokens(JSON.stringify(result.observation)),
        0,
      );
    results.push({
      query: q.query,
      category: q.category,
      recall_5: recall(retrieved, relevant, 5),
      recall_10: recall(retrieved, relevant, 10),
      precision_5: precision(retrieved, relevant, 5),
      ndcg_10: ndcg(retrieved, relevant, 10),
      mrr_val: mrr(retrieved, relevant),
      relevant_count: relevant.size,
      latency_ms: latency,
      retrieved_ids: retrieved,
      returned_tokens: returnedTokens,
    });
  }

  const avgReturnedTokens = Math.round(
    avg(results.map((result) => result.returned_tokens)),
  );

  return {
    name,
    results,
    embed_time_ms: embedTime,
    tokens_per_query: avgReturnedTokens,
    snapshot_reads: kv.snapshotReads(),
    snapshot_writes: kv.snapshotWrites(),
    snapshot_nodes: graphSnapshot?.stats.totalNodes ?? 0,
    snapshot_edges: graphSnapshot?.stats.totalEdges ?? 0,
    graph_search_enabled: graphSearchEnabled,
  };
}

async function evalBuiltinGrep(
  observations: CompressedObservation[],
  queries: LabeledQuery[],
): Promise<SystemResult> {
  const results: QueryResult[] = [];
  const allTokens = estimateTokens(observations.map(o =>
    `## ${o.title}\n${o.narrative}\nConcepts: ${o.concepts.join(", ")}`
  ).join("\n\n"));

  for (const q of queries) {
    const relevant = new Set(q.relevantObsIds);
    const queryTerms = q.query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    const start = performance.now();

    const scored: Array<{ id: string; score: number }> = [];
    for (const obs of observations) {
      const text = [obs.title, obs.narrative, ...obs.concepts, ...obs.facts].join(" ").toLowerCase();
      let score = 0;
      for (const term of queryTerms) if (text.includes(term)) score++;
      if (score > 0) scored.push({ id: obs.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const latency = performance.now() - start;

    const retrieved = scored.map(s => s.id).slice(0, 20);
    results.push({
      query: q.query,
      category: q.category,
      recall_5: recall(retrieved, relevant, 5),
      recall_10: recall(retrieved, relevant, 10),
      precision_5: precision(retrieved, relevant, 5),
      ndcg_10: ndcg(retrieved, relevant, 10),
      mrr_val: mrr(retrieved, relevant),
      relevant_count: relevant.size,
      latency_ms: latency,
      retrieved_ids: retrieved,
      returned_tokens: allTokens,
    });
  }

  return {
    name: "Built-in (grep all)",
    results,
    embed_time_ms: 0,
    tokens_per_query: allTokens,
    snapshot_reads: 0,
    snapshot_writes: 0,
    snapshot_nodes: 0,
    snapshot_edges: 0,
    graph_search_enabled: false,
  };
}

function queryResult(system: SystemResult, query: string): QueryResult {
  const result = system.results.find((candidate) => candidate.query === query);
  if (!result) {
    throw new Error(`Missing query result for ${query} in ${system.name}`);
  }
  return result;
}

function validateGraphBenchmark(
  dual: SystemResult,
  triple: SystemResult,
  graphLinks: GraphBenchmarkLink[],
  zeroEntityQuery: string,
  zeroEntityIds: string[],
): GraphValidityEvidence {
  assert.equal(triple.graph_search_enabled, true);
  assert.equal(triple.snapshot_writes, 1);
  assert(triple.snapshot_reads > 0, "Triple-stream search never read the graph snapshot");
  assert(triple.snapshot_nodes > 0, "Triple-stream graph snapshot has no nodes");
  assert(triple.snapshot_edges > 0, "Triple-stream graph snapshot has no edges");

  const recoveredLinks = graphLinks.filter((link) => {
    const dualIds = queryResult(dual, link.query).retrieved_ids.slice(0, 10);
    const tripleIds = queryResult(triple, link.query).retrieved_ids.slice(0, 10);
    return (
      !dualIds.includes(link.graphOnlyObsId) &&
      tripleIds.includes(link.graphOnlyObsId)
    );
  });
  assert(
    recoveredLinks.length > 0,
    "Triple-stream recovered no graph-only gold documents that dual-stream missed",
  );

  const proof = recoveredLinks[0];
  const dualIds = queryResult(dual, proof.query).retrieved_ids.slice(0, 10);
  const tripleIds = queryResult(triple, proof.query).retrieved_ids.slice(0, 10);
  assert.equal(dualIds.includes(proof.graphOnlyObsId), false);
  assert.equal(tripleIds.includes(proof.graphOnlyObsId), true);
  assert.notDeepEqual(tripleIds, dualIds);

  return {
    proof,
    dualIds,
    tripleIds,
    connectedProbeHits: graphLinks.filter((link) =>
      queryResult(triple, link.query)
        .retrieved_ids.slice(0, 10)
        .includes(link.graphOnlyObsId),
    ).length,
    recallDelta:
      avg(triple.results.map((result) => result.recall_10)) -
      avg(dual.results.map((result) => result.recall_10)),
    zeroEntityQuery,
    zeroEntityIds,
  };
}

async function runZeroEntityProbe(
  observation: CompressedObservation,
  graphSnapshot: GraphSnapshot,
): Promise<{ query: string; ids: string[] }> {
  const query = observation.title.toLowerCase();
  assert.deepEqual(extractEntitiesFromQuery(query), []);

  const makeSearch = async (graphSearchEnabled: boolean) => {
    const bm25 = new SearchIndex();
    bm25.add(observation);
    const kv = mockKV();
    await kv.set(
      KV.observations(observation.sessionId),
      observation.id,
      observation,
    );
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, graphSnapshot);
    const results = await new HybridSearch(
      bm25,
      null,
      null,
      kv as never,
      1,
      0,
      1,
      false,
      graphSearchEnabled,
    ).search(query, 10);
    return {
      ids: results.map((result) => result.observation.id),
      snapshotReads: kv.snapshotReads(),
    };
  };

  const dual = await makeSearch(false);
  const triple = await makeSearch(true);
  assert.deepEqual(triple.ids, dual.ids);
  assert.equal(triple.snapshotReads, 0);
  return { query, ids: triple.ids };
}

function generateReport(options: {
  systems: SystemResult[];
  observationCount: number;
  sessionCount: number;
  queryCount: number;
  triple: SystemResult;
  evidence: GraphValidityEvidence;
}): string {
  const {
    systems,
    observationCount,
    sessionCount,
    queryCount,
    triple,
    evidence,
  } = options;
  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  w("# agentmemory real embeddings quality evaluation");
  w("");
  w(`Date: ${new Date().toISOString()}`);
  w(`Platform: ${process.platform} ${process.arch}, Node ${process.version}`);
  w(
    `Dataset: ${BENCHMARK_DATASET_VERSION}, ${observationCount} observations, ` +
      `${sessionCount} sessions, ${queryCount} labeled queries`,
  );
  w("Embedding model: Xenova/all-MiniLM-L6-v2, 384 dimensions, local");
  w("");
  w("## Retrieval results");
  w("");
  w("| System | Recall@5 | Recall@10 | Precision@5 | NDCG@10 | MRR | Avg Latency | Tokens/query |");
  w("|--------|----------|-----------|-------------|---------|-----|-------------|--------------|");
  for (const s of systems) {
    const r = s.results;
    w(`| ${s.name} | ${pct(avg(r.map(q => q.recall_5)))} | ${pct(avg(r.map(q => q.recall_10)))} | ${pct(avg(r.map(q => q.precision_5)))} | ${pct(avg(r.map(q => q.ndcg_10)))} | ${pct(avg(r.map(q => q.mrr_val)))} | ${avg(r.map(q => q.latency_ms)).toFixed(2)}ms | ${s.tokens_per_query.toLocaleString()} |`);
  }
  w("");
  w("## Graph validity checks");
  w("");
  w(
    `Snapshot consulted: ${triple.snapshot_reads} reads after ` +
      `${triple.snapshot_writes} isolated write; ${triple.snapshot_nodes} nodes, ` +
      `${triple.snapshot_edges} edges.`,
  );
  w(`Proof query: ${evidence.proof.query}`);
  w(`Graph-only gold: ${evidence.proof.graphOnlyObsId}`);
  w(`Dual top 10: ${evidence.dualIds.join(", ")}`);
  w(`Triple top 10: ${evidence.tripleIds.join(", ")}`);
  w("Proof: dual missed the graph-only gold, triple recovered it, and result sets differ.");
  w(
    `Graph-specific probes with connected gold in triple top 10: ` +
      `${evidence.connectedProbeHits}/20.`,
  );
  w(
    `Zero-entity probe: ${evidence.zeroEntityQuery}; result IDs ` +
      `${evidence.zeroEntityIds.join(", ")}; graph snapshot reads 0.`,
  );
  w("");
  w("## Production re-enable gate");
  w("");
  w(
    "Graph should only be re-enabled in production if it adds at least " +
      "+3.0 absolute Recall@10 points on this 100-query-or-larger fixture " +
      "and returns relevant connected results on at least 16 of 20 hand-checked graph probes.",
  );
  w(
    `Current run: ${(evidence.recallDelta * 100).toFixed(1)} Recall@10 points, ` +
      `${evidence.connectedProbeHits}/20 probes - ` +
      `${evidence.recallDelta >= 0.03 && evidence.connectedProbeHits >= 16 ? "PASS" : "HOLD"}.`,
  );

  return lines.join("\n");
}

async function main(): Promise<void> {
  console.log("=== agentmemory Real Embeddings Benchmark ===\n");

  console.log("Loading Xenova/all-MiniLM-L6-v2 model (first run downloads ~80MB)...");
  const provider = new LocalEmbeddingProvider();
  try {
    const testEmbed = await provider.embed("test");
    console.log(`Model loaded. Dimensions: ${testEmbed.length}\n`);
  } catch (err) {
    console.error("Failed to load Xenova model:", err);
    console.error("Install with: npm install @xenova/transformers");
    throw err;
  }

  const { observations, queries, sessions, graphLinks } = generateDataset();
  assert(queries.length >= 100, "Benchmark requires at least 100 labeled queries");
  assert.equal(graphLinks.length, 20);
  const graphSnapshot = buildBenchmarkGraphSnapshot(observations, graphLinks);
  assert.equal(graphSnapshot.stats.totalNodes, graphLinks.length * 2);
  assert.equal(graphSnapshot.stats.totalEdges, graphLinks.length);
  console.log(
    `Dataset: ${BENCHMARK_DATASET_VERSION}, ${observations.length} observations, ` +
      `${sessions.size} sessions, ${queries.length} queries\n`,
  );

  console.log("1. Built-in (grep all)...");
  const builtinResult = await evalBuiltinGrep(observations, queries);
  console.log(`   Recall@10: ${pct(avg(builtinResult.results.map(q => q.recall_10)))}\n`);

  console.log("2. BM25-only (stemmed+synonyms)...");
  const bm25Result = await evalSystem({
    name: "BM25-only (stemmed+synonyms)",
    observations,
    queries,
    provider: null,
    weights: { bm25: 1, vector: 0, graph: 0 },
  });
  console.log(`   Recall@10: ${pct(avg(bm25Result.results.map(q => q.recall_10)))}\n`);

  console.log("3. Dual-stream (BM25 + real Xenova vectors)...");
  const dualResult = await evalSystem({
    name: "Dual-stream (BM25+Xenova)",
    observations,
    queries,
    provider,
    weights: { bm25: 0.4, vector: 0.6, graph: 0 },
  });
  console.log(`   Recall@10: ${pct(avg(dualResult.results.map(q => q.recall_10)))}\n`);

  console.log("4. Triple-stream (BM25 + Xenova + Graph)...");
  const tripleResult = await evalSystem({
    name: "Triple-stream (BM25+Xenova+Graph, graph weight 1.0)",
    observations,
    queries,
    provider,
    weights: { bm25: 0.4, vector: 0.6, graph: 1 },
    graphSnapshot,
    graphSearchEnabled: true,
  });
  console.log(`   Recall@10: ${pct(avg(tripleResult.results.map(q => q.recall_10)))}\n`);

  const zeroEntity = await runZeroEntityProbe(observations[0], graphSnapshot);
  const evidence = validateGraphBenchmark(
    dualResult,
    tripleResult,
    graphLinks,
    zeroEntity.query,
    zeroEntity.ids,
  );
  console.log("Graph validity assertions: PASS");
  console.log(`  Snapshot reads: ${tripleResult.snapshot_reads}`);
  console.log(`  Proof query: ${evidence.proof.query}`);
  console.log(`  Graph-only gold recovered: ${evidence.proof.graphOnlyObsId}`);
  console.log(`  Dual top 10: ${evidence.dualIds.join(", ")}`);
  console.log(`  Triple top 10: ${evidence.tripleIds.join(", ")}\n`);

  const report = generateReport({
    systems: [builtinResult, bm25Result, dualResult, tripleResult],
    observationCount: observations.length,
    sessionCount: sessions.size,
    queryCount: queries.length,
    triple: tripleResult,
    evidence,
  });

  writeFileSync("benchmark/REAL-EMBEDDINGS.md", report);
  console.log(report);
  console.log(`\nReport written to benchmark/REAL-EMBEDDINGS.md`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
