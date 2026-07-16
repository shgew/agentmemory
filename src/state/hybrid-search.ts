import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type {
  EmbeddingProvider,
  HybridSearchResult,
  CompressedObservation,
  Memory,
  QueryExpansion,
} from "../types.js";
import { memoryToObservation } from "./memory-utils.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import {
  GraphRetrieval,
  type GraphRetrievalResult,
} from "../functions/graph-retrieval.js";
import { extractEntitiesFromQuery } from "../functions/query-expansion.js";
import { rerank } from "./reranker.js";
import { getEnvVar, isGraphSearchEnabled } from "../config.js";

const RRF_K = 60;

export interface HybridSearchTimings {
  bm25SearchMs: number;
  vectorSearchMs: number;
  rankingRrfFusionMs: number;
}

export class HybridSearch {
  private graphRetrieval: GraphRetrieval;

  constructor(
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    private embeddingProvider: EmbeddingProvider | null,
    private kv: StateKV,
    private bm25Weight = 0.4,
    private vectorWeight = 0.6,
    private graphWeight = 0.3,
    private rerankEnabled = getEnvVar("RERANK_ENABLED") === "true",
    private graphSearchEnabled = isGraphSearchEnabled(),
  ) {
    this.graphRetrieval = new GraphRetrieval(kv);
  }

  async search(
    query: string,
    limit = 20,
    timings?: HybridSearchTimings,
  ): Promise<HybridSearchResult[]> {
    return this.tripleStreamSearch(query, limit, undefined, timings);
  }

  async searchWithExpansion(
    query: string,
    limit: number,
    expansion: QueryExpansion,
  ): Promise<HybridSearchResult[]> {
    const allQueries = [
      query,
      ...expansion.reformulations,
      ...expansion.temporalConcretizations,
    ];

    const allEntities = [
      ...expansion.entityExtractions,
      ...extractEntitiesFromQuery(query),
    ];

    const resultSets = await Promise.all(
      allQueries.map((q) => this.tripleStreamSearch(q, limit, allEntities)),
    );

    const merged = new Map<string, HybridSearchResult>();
    for (const results of resultSets) {
      for (const r of results) {
        const existing = merged.get(r.observation.id);
        if (!existing || r.combinedScore > existing.combinedScore) {
          merged.set(r.observation.id, r);
        }
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, limit);
  }

  private async tripleStreamSearch(
    query: string,
    limit: number,
    entityHints?: string[],
    timings?: HybridSearchTimings,
  ): Promise<HybridSearchResult[]> {
    if (timings) {
      timings.bm25SearchMs = 0;
      timings.vectorSearchMs = 0;
      timings.rankingRrfFusionMs = 0;
    }
    const bm25StartedAt = timings ? performance.now() : 0;
    const bm25Results = this.bm25.search(query, limit * 2);
    if (timings) timings.bm25SearchMs = performance.now() - bm25StartedAt;

    let vectorResults: Array<{
      obsId: string;
      sessionId: string;
      score: number;
    }> = [];
    let queryEmbedding: Float32Array | null = null;

    if (this.vector && this.embeddingProvider && this.vector.size > 0) {
      const vectorStartedAt = timings ? performance.now() : 0;
      try {
        queryEmbedding = await this.embeddingProvider.embed(query);
        vectorResults = this.vector.search(queryEmbedding, limit * 2);
      } catch {
        // fall through to BM25-only
      } finally {
        if (timings) timings.vectorSearchMs = performance.now() - vectorStartedAt;
      }
    }

    let graphResults: GraphRetrievalResult[] = [];
    // GRAPH_SEARCH_ENABLED is a TRUE bypass: when off, the graph snapshot is
    // never read and GraphRetrieval never runs, so no graph stream enters RRF
    // fusion (distinct from graphWeight=0, which still traverses then zeroes).
    if (this.graphSearchEnabled) {
      const entities =
        entityHints && entityHints.length > 0
          ? entityHints
          : extractEntitiesFromQuery(query);
      if (entities.length > 0) {
        try {
          graphResults = await this.graphRetrieval.searchByEntities(
            entities,
            2,
            limit,
          );
        } catch {
          // graph search is best-effort
        }
      }

      const topVectorObs = vectorResults.slice(0, 5).map((r) => r.obsId);
      if (topVectorObs.length > 0) {
        try {
          const expansionResults =
            await this.graphRetrieval.expandFromChunks(topVectorObs, 1, 5);
          graphResults = [...graphResults, ...expansionResults];
        } catch {
          // expansion is best-effort
        }
      }
    }

    const rankingStartedAt = timings ? performance.now() : 0;
    const scores = new Map<
      string,
      {
        bm25Rank: number;
        vectorRank: number;
        graphRank: number;
        sessionId: string;
        bm25Score: number;
        vectorScore: number;
        graphScore: number;
        graphContext?: string;
      }
    >();

    bm25Results.forEach((r, i) => {
      scores.set(r.obsId, {
        bm25Rank: i + 1,
        vectorRank: Infinity,
        graphRank: Infinity,
        sessionId: r.sessionId,
        bm25Score: r.score,
        vectorScore: 0,
        graphScore: 0,
      });
    });

    vectorResults.forEach((r, i) => {
      const existing = scores.get(r.obsId);
      if (existing) {
        existing.vectorRank = i + 1;
        existing.vectorScore = r.score;
      } else {
        scores.set(r.obsId, {
          bm25Rank: Infinity,
          vectorRank: i + 1,
          graphRank: Infinity,
          sessionId: r.sessionId,
          bm25Score: 0,
          vectorScore: r.score,
          graphScore: 0,
        });
      }
    });

    graphResults.forEach((r, i) => {
      const existing = scores.get(r.obsId);
      if (existing) {
        existing.graphRank = Math.min(existing.graphRank, i + 1);
        existing.graphScore = Math.max(existing.graphScore, r.score);
        if (r.graphContext && !existing.graphContext) {
          existing.graphContext = r.graphContext;
        }
      } else {
        scores.set(r.obsId, {
          bm25Rank: Infinity,
          vectorRank: Infinity,
          graphRank: i + 1,
          sessionId: r.sessionId || this.bm25.getSessionId(r.obsId) || "",
          bm25Score: 0,
          vectorScore: 0,
          graphScore: r.score,
          graphContext: r.graphContext,
        });
      }
    });

    const hasVector = vectorResults.length > 0;
    const hasGraph = graphResults.length > 0;

    let effectiveBm25W = this.bm25Weight;
    let effectiveVectorW = hasVector ? this.vectorWeight : 0;
    let effectiveGraphW = hasGraph ? this.graphWeight : 0;

    const totalW = effectiveBm25W + effectiveVectorW + effectiveGraphW;
    if (totalW > 0) {
      effectiveBm25W /= totalW;
      effectiveVectorW /= totalW;
      effectiveGraphW /= totalW;
    }

    const combined = Array.from(scores.entries()).map(([obsId, s]) => ({
      obsId,
      sessionId: s.sessionId,
      bm25Score: s.bm25Score,
      vectorScore: s.vectorScore,
      graphScore: s.graphScore,
      graphContext: s.graphContext,
      combinedScore:
        effectiveBm25W * (1 / (RRF_K + s.bm25Rank)) +
        effectiveVectorW * (1 / (RRF_K + s.vectorRank)) +
        effectiveGraphW * (1 / (RRF_K + s.graphRank)),
    }));

    combined.sort((a, b) => b.combinedScore - a.combinedScore);

    const retrievalDepth = Math.max(limit, 20);
    const rerankWindow = 20;
    const diversified = this.diversifyBySession(combined, retrievalDepth);
    const enriched = await this.enrichResults(diversified, retrievalDepth);

    if (this.rerankEnabled && enriched.length > 1) {
      try {
        const head = enriched.slice(0, rerankWindow);
        const tail = enriched.slice(rerankWindow);
        const reranked = await rerank(query, head, rerankWindow);
        if (timings) {
          timings.rankingRrfFusionMs = performance.now() - rankingStartedAt;
        }
        return reranked.concat(tail).slice(0, limit);
      } catch {
        if (timings) {
          timings.rankingRrfFusionMs = performance.now() - rankingStartedAt;
        }
        return enriched.slice(0, limit);
      }
    }

    if (timings) {
      timings.rankingRrfFusionMs = performance.now() - rankingStartedAt;
    }
    return enriched.slice(0, limit);
  }

  private diversifyBySession(
    results: Array<{
      obsId: string;
      sessionId: string;
      bm25Score: number;
      vectorScore: number;
      graphScore: number;
      combinedScore: number;
      graphContext?: string;
    }>,
    limit: number,
    maxPerSession = 3,
  ): typeof results {
    const selected: typeof results = [];
    const sessionCounts = new Map<string, number>();

    for (const r of results) {
      const count = sessionCounts.get(r.sessionId) || 0;
      if (count >= maxPerSession) continue;
      selected.push(r);
      sessionCounts.set(r.sessionId, count + 1);
      if (selected.length >= limit) break;
    }

    if (selected.length < limit) {
      for (const r of results) {
        if (selected.length >= limit) break;
        if (!selected.some(s => s.obsId === r.obsId)) {
          selected.push(r);
        }
      }
    }

    return selected;
  }

  private async enrichResults(
    results: Array<{
      obsId: string;
      sessionId: string;
      bm25Score: number;
      vectorScore: number;
      graphScore: number;
      combinedScore: number;
      graphContext?: string;
    }>,
    limit: number,
  ): Promise<HybridSearchResult[]> {
    const sliced = results.slice(0, limit);
    const observations = await Promise.all(
      sliced.map(async (r) => {
        const sessionId = r.sessionId || this.bm25.getSessionId(r.obsId);
        const obs = sessionId
          ? await this.kv
              .get<CompressedObservation>(KV.observations(sessionId), r.obsId)
              .catch(() => null)
          : null;
        if (obs) {
          return {
            observation: obs,
            ownerScope: "observation" as const,
            sessionId: sessionId || r.sessionId,
          };
        }
        // Fallback: indexed entry may originate from mem::remember, which
        // writes to KV.memories with a synthetic sessionId ("memory" or the
        // memory's first associated session). Coerce the Memory record into
        // a CompressedObservation so search/recall surface saved memories.
        const mem = await this.kv
          .get<Memory>(KV.memories, r.obsId)
          .catch(() => null);
        return mem
          ? {
              observation: memoryToObservation(mem),
              ownerScope: "memory" as const,
              sessionId: sessionId || r.sessionId,
            }
          : null;
      }),
    );
    const enriched: HybridSearchResult[] = [];
    for (let i = 0; i < sliced.length; i++) {
      const result = observations[i];
      if (result) {
        enriched.push({
          observation: result.observation,
          ownerScope: result.ownerScope,
          bm25Score: sliced[i].bm25Score,
          vectorScore: sliced[i].vectorScore,
          graphScore: sliced[i].graphScore,
          combinedScore: sliced[i].combinedScore,
          sessionId: result.sessionId,
          graphContext: sliced[i].graphContext,
        });
      }
    }
    return enriched;
  }
}
