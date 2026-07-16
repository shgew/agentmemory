import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId, jaccardSimilarity } from "../state/schema.js";
import { logger } from "../logger.js";
import type {
  Insight,
  GraphNode,
  GraphEdge,
  SemanticMemory,
  Lesson,
  Crystal,
  MemoryProvider,
  Memory,
  Session,
  SessionSummary,
} from "../types.js";
import { recordAudit } from "./audit.js";
import { REFLECT_SYSTEM, buildReflectPrompt } from "../prompts/reflect.js";
import { readGraphSnapshot } from "../state/graph-snapshot.js";
import { filterSupersededLessons } from "./lesson-state.js";
import { getEnvVar } from "../config.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

const REFLECT_CLUSTER_FP_VERSION = 2;

interface ConceptCluster {
  concepts: string[];
  facts: Array<{ fact: string; confidence: number }>;
  lessons: Array<{ content: string; confidence: number }>;
  crystalNarratives: string[];
  factIds: string[];
  lessonIds: string[];
  crystalIds: string[];
}

interface PreparedCluster {
  conceptNames: string[];
  facts: SemanticMemory[];
  lessons: Lesson[];
  crystals: Crystal[];
  identityFp: string;
}

function normalizeEvidenceText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function evidenceFingerprint(
  project: string | undefined,
  conceptNames: string[],
  facts: SemanticMemory[],
  lessons: Lesson[],
  crystals: Crystal[],
): string {
  const lessonVersion = (lesson: Lesson): string | number =>
    (lesson as Lesson & { version?: string | number }).version ??
    lesson.updatedAt;
  return fingerprintId(
    "cluster",
    JSON.stringify({
      version: REFLECT_CLUSTER_FP_VERSION,
      project: project ?? "",
      concepts: conceptNames
        .map((concept) => normalizeEvidenceText(concept))
        .sort(),
      facts: facts
        .map(
          (fact): [string, number, string] => [
            fact.id,
            fact.confidence,
            normalizeEvidenceText(fact.fact),
          ],
        )
        .sort(([left], [right]) => left.localeCompare(right)),
      lessons: lessons
        .map(
          (lesson): [string, string | number, number, string] => [
            lesson.id,
            lessonVersion(lesson),
            lesson.confidence,
            normalizeEvidenceText(lesson.content),
          ],
        )
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
      crystals: crystals
        .map((crystal) => [
          crystal.id,
          normalizeEvidenceText(
            [crystal.narrative, ...(crystal.lessons ?? [])].join("\n"),
          ),
        ])
        .sort(([left], [right]) => left.localeCompare(right)),
    }),
  );
}

function memoryBelongsToProject(
  memory: Memory,
  project: string,
  projectSessionIds: Set<string>,
): boolean {
  if (memory.project !== undefined) return memory.project === project;
  return memory.sessionIds.some((sessionId) => projectSessionIds.has(sessionId));
}

function semanticBelongsToProject(
  semantic: SemanticMemory,
  projectSessionIds: Set<string>,
  projectMemoryIds: Set<string>,
): boolean {
  return (
    semantic.sourceSessionIds.some((id) => projectSessionIds.has(id)) ||
    semantic.sourceMemoryIds.some((id) => projectMemoryIds.has(id))
  );
}

function crystalBelongsToProject(
  crystal: Crystal,
  project: string,
  projectSessionIds: Set<string>,
): boolean {
  if (crystal.project !== undefined) return crystal.project === project;
  return !!crystal.sessionId && projectSessionIds.has(crystal.sessionId);
}

async function readProjectEvidence(
  kv: StateKV,
  project: string,
): Promise<{ sessionIds: Set<string>; memoryIds: Set<string> }> {
  const [sessions, summaries, memories] = await Promise.all([
    kv.list<Session>(KV.sessions),
    kv.list<SessionSummary>(KV.summaries),
    kv.list<Memory>(KV.memories),
  ]);
  const sessionIds = new Set([
    ...sessions.filter((session) => session.project === project).map((session) => session.id),
    ...summaries.filter((summary) => summary.project === project).map((summary) => summary.sessionId),
  ]);
  for (const memory of memories) {
    if (memory.project === project) {
      for (const sessionId of memory.sessionIds) sessionIds.add(sessionId);
    }
  }
  const memoryIds = new Set(
    memories
      .filter((memory) => memoryBelongsToProject(memory, project, sessionIds))
      .map((memory) => memory.id),
  );
  return { sessionIds, memoryIds };
}

function reinforceInsight(insight: Insight): void {
  const now = new Date().toISOString();
  insight.reinforcements++;
  insight.confidence = Math.min(
    1.0,
    insight.confidence + 0.1 * (1 - insight.confidence),
  );
  insight.lastReinforcedAt = now;
  insight.updatedAt = now;
}

function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameInsightTitle(a: string, b: string): boolean {
  const normA = normalizeForMatch(a);
  const normB = normalizeForMatch(b);
  if (normA === normB) return true;
  const tokensA = normA.split(" ").filter((t) => t.length > 2);
  const tokensB = normB.split(" ").filter((t) => t.length > 2);
  if (tokensA.length < 4 || tokensB.length < 4) return false;
  return jaccardSimilarity(normA, normB) >= 0.9;
}

function isBetterRepresentative(candidate: Insight, current: Insight): boolean {
  if (candidate.confidence !== current.confidence) {
    return candidate.confidence > current.confidence;
  }
  const candTime = candidate.lastReinforcedAt ?? candidate.updatedAt;
  const currTime = current.lastReinforcedAt ?? current.updatedAt;
  return candTime > currTime;
}

function collapseInsightsByTitle<T extends Insight>(items: T[]): T[] {
  const reps: T[] = [];
  for (const item of items) {
    let merged = false;
    for (let i = 0; i < reps.length; i++) {
      if (item.project === reps[i].project && sameInsightTitle(item.title, reps[i].title)) {
        if (isBetterRepresentative(item, reps[i])) reps[i] = item;
        merged = true;
        break;
      }
    }
    if (!merged) reps.push(item);
  }
  return reps;
}

function isNearDuplicateInsight(
  a: { title: string; content: string },
  b: { title: string; content: string },
): boolean {
  const titleSim = jaccardSimilarity(
    normalizeForMatch(a.title),
    normalizeForMatch(b.title),
  );
  if (titleSim < 0.75) return false;
  const combinedSim = jaccardSimilarity(
    normalizeForMatch(`${a.title} ${a.content}`),
    normalizeForMatch(`${b.title} ${b.content}`),
  );
  return combinedSim >= 0.88;
}

function findNearDuplicateInsight(
  candidate: { title: string; content: string; project?: string },
  existing: Insight[],
): Insight | null {
  let best: Insight | null = null;
  let bestSim = 0;
  for (const ins of existing) {
    if (ins.deleted) continue;
    if (ins.project !== candidate.project) continue;
    if (!isNearDuplicateInsight(candidate, ins)) continue;
    const sim = jaccardSimilarity(
      normalizeForMatch(`${candidate.title} ${candidate.content}`),
      normalizeForMatch(`${ins.title} ${ins.content}`),
    );
    if (sim > bestSim) {
      bestSim = sim;
      best = ins;
    }
  }
  return best;
}

function boundedUnion(
  existing: string[],
  incoming: string[],
  cap: number,
): string[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing);
  const result = existing.slice();
  for (const item of incoming) {
    if (result.length >= cap) break;
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function reinforceInsightWithProvenance(
  insight: Insight,
  cluster: ConceptCluster,
  conceptNames: string[],
): void {
  insight.sourceMemoryIds = boundedUnion(insight.sourceMemoryIds, cluster.factIds, 100);
  insight.sourceLessonIds = boundedUnion(insight.sourceLessonIds, cluster.lessonIds, 100);
  insight.sourceCrystalIds = boundedUnion(insight.sourceCrystalIds, cluster.crystalIds, 100);
  insight.sourceConceptCluster = boundedUnion(insight.sourceConceptCluster, conceptNames, 50);
  insight.tags = boundedUnion(insight.tags, conceptNames, 50);
}

function stampClusterFingerprint(insight: Insight, clusterFp: string): void {
  insight.reflectClusterFp = clusterFp;
  insight.reflectClusterFps = boundedUnion(
    insight.reflectClusterFps ?? [],
    [clusterFp],
    100,
  );
  insight.reflectClusterFpVersion = REFLECT_CLUSTER_FP_VERSION;
}

function hasClusterFingerprint(insight: Insight, clusterFp: string): boolean {
  if (insight.reflectClusterFpVersion !== REFLECT_CLUSTER_FP_VERSION) {
    return false;
  }
  return (
    insight.reflectClusterFp === clusterFp ||
    insight.reflectClusterFps?.includes(clusterFp) === true
  );
}

function buildGraphClusters(
  nodes: GraphNode[],
  edges: GraphEdge[],
  maxClusters: number,
): string[][] {
  const conceptNodes = nodes.filter(
    (n) => n.type === "concept" && !n.stale,
  );
  if (conceptNodes.length === 0) return [];

  const edgeMap = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.stale) continue;
    if (!edgeMap.has(edge.sourceNodeId))
      edgeMap.set(edge.sourceNodeId, new Set());
    if (!edgeMap.has(edge.targetNodeId))
      edgeMap.set(edge.targetNodeId, new Set());
    edgeMap.get(edge.sourceNodeId)!.add(edge.targetNodeId);
    edgeMap.get(edge.targetNodeId)!.add(edge.sourceNodeId);
  }

  const degree = new Map<string, number>();
  for (const node of conceptNodes) {
    degree.set(node.id, edgeMap.get(node.id)?.size || 0);
  }

  const sorted = [...conceptNodes].sort(
    (a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0),
  );

  const visited = new Set<string>();
  const clusters: string[][] = [];
  const conceptNodeById = new Map(conceptNodes.map((n) => [n.id, n]));

  for (const seed of sorted) {
    if (clusters.length >= maxClusters) break;
    if (visited.has(seed.id)) continue;

    const cluster: string[] = [];
    const queue = [seed.id];
    const seen = new Set<string>();
    let depth = 0;

    while (queue.length > 0 && depth <= 2) {
      const levelCount = queue.length;
      for (let i = 0; i < levelCount; i++) {
        const current = queue.shift()!;
        if (seen.has(current)) continue;
        seen.add(current);

        if (conceptNodeById.has(current)) {
          const node = conceptNodeById.get(current);
          if (node) cluster.push(node.name);
          visited.add(current);
        }

        const neighbors = edgeMap.get(current) || new Set();
        for (const neighbor of neighbors) {
          if (!seen.has(neighbor)) queue.push(neighbor);
        }
      }
      depth++;
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }

  return clusters;
}

const III_INVOCATION_CAP_MS = 900_000;
const REFLECT_BUDGET_MARGIN_MS = 60_000;
const REFLECT_TIMEOUT_MS_DEFAULT = 600_000;

export function readMaxSingleCallMs(): number {
  for (const key of ["OPENAI_TIMEOUT_MS", "AGENTMEMORY_LLM_TIMEOUT_MS"]) {
    const raw = getEnvVar(key);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 60_000;
}

export function readReflectTimeoutMs(): number {
  const maxSingleCall = readMaxSingleCallMs();
  const ceiling = Math.max(
    60_000,
    III_INVOCATION_CAP_MS - maxSingleCall - REFLECT_BUDGET_MARGIN_MS,
  );
  const raw = getEnvVar("AGENTMEMORY_REFLECT_TIMEOUT_MS");
  if (!raw) return ceiling;
  const n = Number(raw);
  const configured = Number.isFinite(n) && n > 0 ? n : REFLECT_TIMEOUT_MS_DEFAULT;
  if (configured > ceiling) {
    logger.warn(
      "AGENTMEMORY_REFLECT_TIMEOUT_MS exceeds the safe ceiling under the iii invocation cap; clamping",
      { configured, ceiling, maxSingleCall, cap: III_INVOCATION_CAP_MS, margin: REFLECT_BUDGET_MARGIN_MS },
    );
  }
  return Math.min(configured, ceiling);
}

function buildJaccardClusters(
  semanticMemories: SemanticMemory[],
  lessons: Lesson[],
  maxClusters: number,
): string[][] {
  const allConcepts = new Map<string, Set<string>>();

  for (const sem of semanticMemories) {
    const terms = sem.fact.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
    for (const term of terms) {
      if (!allConcepts.has(term)) allConcepts.set(term, new Set());
      allConcepts.get(term)!.add(sem.id);
    }
  }
  for (const lesson of lessons) {
    for (const tag of lesson.tags) {
      const key = tag.toLowerCase();
      if (!allConcepts.has(key)) allConcepts.set(key, new Set());
      allConcepts.get(key)!.add(lesson.id);
    }
  }

  const conceptList = [...allConcepts.keys()].filter(
    (k) => (allConcepts.get(k)?.size || 0) >= 2,
  );

  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const concept of conceptList) {
    if (clusters.length >= maxClusters) break;
    if (visited.has(concept)) continue;

    const cluster = [concept];
    visited.add(concept);

    const docsA = allConcepts.get(concept) || new Set();
    for (const other of conceptList) {
      if (visited.has(other)) continue;
      const docsB = allConcepts.get(other) || new Set();
      let intersection = 0;
      for (const d of docsA) {
        if (docsB.has(d)) intersection++;
      }
      const union = docsA.size + docsB.size - intersection;
      const similarity = union > 0 ? intersection / union : 0;
      if (similarity > 0.3) {
        cluster.push(other);
        visited.add(other);
      }
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }

  return clusters;
}

function prepareCluster(
  conceptNames: string[],
  semanticMemories: SemanticMemory[],
  lessons: Lesson[],
  crystals: Crystal[],
  project: string | undefined,
): PreparedCluster {
  const conceptSet = new Set(conceptNames.map((concept) => concept.toLowerCase()));
  const facts = semanticMemories.filter((semantic) =>
    semantic.fact
      .toLowerCase()
      .split(/\s+/)
      .some((term) => conceptSet.has(term)),
  );
  const matchingLessons = lessons.filter(
    (lesson) =>
      lesson.tags.some((tag) => conceptSet.has(tag.toLowerCase())) ||
      conceptNames.some((concept) =>
        lesson.content.toLowerCase().includes(concept.toLowerCase()),
      ),
  );
  const matchingCrystals = crystals.filter((crystal) =>
    crystal.lessons.some((lesson) =>
      conceptNames.some((concept) =>
        lesson.toLowerCase().includes(concept.toLowerCase()),
      ),
    ),
  );
  return {
    conceptNames,
    facts,
    lessons: matchingLessons,
    crystals: matchingCrystals,
    identityFp: evidenceFingerprint(
      project,
      conceptNames,
      facts,
      matchingLessons,
      matchingCrystals,
    ),
  };
}

export function registerReflectFunctions(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::reflect", 
    async (data: { maxClusters?: number; project?: string }) => {
      const project = data?.project;
      const cursorKey = `reflect:cursor:${project || "global"}`;
      return withKeyedLock(cursorKey, async () => {
      const maxClusters = Math.max(1, Math.min(data?.maxClusters ?? 10, 20));
      const maxInsightsPerCluster = 5;
      const maxTotal = 50;
      const reflectStart = Date.now();
      const reflectBudgetMs = readReflectTimeoutMs();
      const cursorState = await kv
        .get<{ processedFps: string[] }>(KV.config, cursorKey)
        .catch(() => null);
      const processedFps = new Set<string>(cursorState?.processedFps ?? []);

      // Snapshot reads bound reflection cost for large graphs.
      const graphSnapshot = await readGraphSnapshot(kv);
      const graphNodes = graphSnapshot?.topNodes ?? [];
      const graphEdges = graphSnapshot?.topEdges ?? [];
      let [semanticMemories, lessons, crystals] = await Promise.all([
        kv.list<SemanticMemory>(KV.semantic),
        kv.list<Lesson>(KV.lessons),
        kv.list<Crystal>(KV.crystals),
      ]);

      let activeLessons = filterSupersededLessons(lessons);
      if (project) {
        const evidence = await readProjectEvidence(kv, project);
        semanticMemories = semanticMemories.filter((semantic) =>
          semanticBelongsToProject(
            semantic,
            evidence.sessionIds,
            evidence.memoryIds,
          ),
        );
        activeLessons = activeLessons.filter((lesson) => lesson.project === project);
        crystals = crystals.filter((crystal) =>
          crystalBelongsToProject(crystal, project, evidence.sessionIds),
        );
      }

      let conceptClusters = buildGraphClusters(
        graphNodes,
        graphEdges,
        maxClusters,
      );

      const usedFallback = conceptClusters.length === 0;
      if (usedFallback) {
        conceptClusters = buildJaccardClusters(
          semanticMemories,
          activeLessons,
          maxClusters,
        );
      }
      const preparedClusters = conceptClusters.map((conceptNames) =>
        prepareCluster(
          conceptNames,
          semanticMemories,
          activeLessons,
          crystals,
          project,
        ),
      );

      let newInsights = 0;
      let reinforced = 0;
      let clustersSkipped = 0;
      let totalInsights = 0;
      let clustersAttempted = 0;
      let clustersFailed = 0;
      let clustersFrozen = 0;
      let budgetExhausted = false;
      const activeInsights: Insight[] = (
        await kv.list<Insight>(KV.insights)
      ).filter((i) => !i.deleted);
      const reinforcedIds = new Set<string>();

      for (const prepared of preparedClusters) {
        if (totalInsights >= maxTotal) break;
        const { conceptNames, facts, lessons: clusterLessons, crystals: clusterCrystals, identityFp } = prepared;
        if (processedFps.has(identityFp)) continue;
        if (Date.now() - reflectStart >= reflectBudgetMs) {
          budgetExhausted = true;
          break;
        }
        const totalItems =
          facts.length + clusterLessons.length + clusterCrystals.length;
        if (totalItems < 3) {
          processedFps.add(identityFp);
          clustersSkipped++;
          continue;
        }

        let clusterFp: string | undefined;
        if (clusterLessons.length >= 1) {
          clusterFp = identityFp;
          if (
            activeInsights.some(
              (insight) => hasClusterFingerprint(insight, identityFp),
            )
          ) {
            processedFps.add(identityFp);
            clustersFrozen++;
            continue;
          }
        }
        clustersAttempted++;

        const cluster: ConceptCluster = {
          concepts: conceptNames,
          facts: facts.map((f) => ({
            fact: f.fact,
            confidence: f.confidence,
          })),
          lessons: clusterLessons.map((l) => ({
            content: l.content,
            confidence: l.confidence,
          })),
          crystalNarratives: clusterCrystals.map((c) => c.narrative),
          factIds: facts.map((f) => f.id),
          lessonIds: clusterLessons.map((l) => l.id),
          crystalIds: clusterCrystals.map((c) => c.id),
        };

        try {
          const prompt = buildReflectPrompt(cluster);
          const response = await provider.summarize(REFLECT_SYSTEM, prompt);

          const insightRegex =
            /<insight\s+confidence="([^"]+)"\s+title="([^"]+)">([\s\S]*?)<\/insight>/g;
          let match;
          let clusterCount = 0;

          while (
            (match = insightRegex.exec(response)) !== null &&
            clusterCount < maxInsightsPerCluster &&
            totalInsights < maxTotal
          ) {
            const parsedConf = parseFloat(match[1]);
            const confidence = Number.isNaN(parsedConf)
              ? 0.5
              : Math.max(0, Math.min(1, parsedConf));
            const title = match[2].trim();
            const content = match[3].trim();

            if (!content) continue;

            const fp = fingerprintId(
              "ins",
              `${data?.project ?? ""}\n${content.trim().toLowerCase()}`,
            );
            let target = await kv.get<Insight>(KV.insights, fp);
            if (target?.deleted) target = null;

            if (!target) {
              const legacyFp = fingerprintId("ins", content.trim().toLowerCase());
              const legacy = await kv.get<Insight>(KV.insights, legacyFp);
              if (legacy && !legacy.deleted && legacy.project === data?.project) {
                target = legacy;
              }
            }

            if (!target) {
              target = findNearDuplicateInsight(
                { title, content, project: data?.project },
                activeInsights,
              );
            }

            if (target) {
              reinforceInsightWithProvenance(target, cluster, conceptNames);
              if (!reinforcedIds.has(target.id)) {
                reinforceInsight(target);
                reinforcedIds.add(target.id);
                reinforced++;
              }
              if (clusterFp !== undefined) {
                stampClusterFingerprint(target, clusterFp);
              }
              await kv.set(KV.insights, target.id, target);
            } else {
              const now = new Date().toISOString();
              const insight: Insight = {
                id: fp,
                title,
                content,
                confidence,
                reinforcements: 0,
                sourceConceptCluster: conceptNames,
                sourceMemoryIds: cluster.factIds,
                sourceLessonIds: cluster.lessonIds,
                sourceCrystalIds: cluster.crystalIds,
                project: data?.project,
                tags: conceptNames,
                createdAt: now,
                updatedAt: now,
                decayRate: 0.05,
              };
              if (clusterFp !== undefined) {
                stampClusterFingerprint(insight, clusterFp);
              }
              await kv.set(KV.insights, insight.id, insight);
              activeInsights.push(insight);
              newInsights++;
            }

            clusterCount++;
            totalInsights++;
          }
          if (clusterCount === 0) {
            clustersFailed++;
            continue;
          }
          processedFps.add(identityFp);
        } catch {
          clustersFailed++;
          continue;
        }
      }
      const fullPassComplete = preparedClusters.every((cluster) =>
        processedFps.has(cluster.identityFp),
      );
      let cursorPersisted = true;
      try {
        await kv.set(KV.config, cursorKey, {
          processedFps: fullPassComplete ? [] : [...processedFps],
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        cursorPersisted = false;
        logger.warn("Reflect cursor update failed", {
          error: err instanceof Error ? err.message : String(err),
          cursorKey,
        });
      }
      const reflectFailed =
        clustersAttempted > 0 && clustersFailed === clustersAttempted;

      try {
        await recordAudit(kv, "reflect", "mem::reflect", [], {
          newInsights,
          reinforced,
          clustersProcessed: clustersAttempted,
          clustersFrozen,
          clustersSkipped,
          usedFallback,
          budgetExhausted,
          fullPassComplete,
        });
      } catch {}

      return {
        success: !reflectFailed && cursorPersisted,
        newInsights,
        reinforced,
        clustersProcessed: clustersAttempted,
        clustersFrozen,
        clustersSkipped,
        usedFallback,
        budgetExhausted,
        fullPassComplete: fullPassComplete && cursorPersisted,
      };
      });
    },
  );

  sdk.registerFunction("mem::insight-list", 
    async (data: {
      project?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      const limit = data?.limit ?? 50;
      const minConfidence = data?.minConfidence ?? 0;
      let items = await kv.list<Insight>(KV.insights);

      items = items.filter(
        (i) => !i.deleted && i.confidence >= minConfidence,
      );

      if (data?.project) {
        items = items.filter((i) => i.project === data.project);
      }

      items = collapseInsightsByTitle(items);

      items.sort((a, b) => b.confidence - a.confidence);

      return { success: true, insights: items.slice(0, limit) };
    },
  );

  sdk.registerFunction("mem::insight-search", 
    async (data: {
      query: string;
      project?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      if (!data?.query?.trim()) {
        return { success: false, error: "query is required" };
      }

      const query = data.query.toLowerCase();
      const minConfidence = data.minConfidence ?? 0.1;
      const limit = data.limit ?? 10;

      let items = await kv.list<Insight>(KV.insights);
      items = items.filter(
        (i) => !i.deleted && i.confidence >= minConfidence,
      );

      if (data.project) {
        items = items.filter((i) => i.project === data.project);
      }

      const terms = query.split(/\s+/).filter((t) => t.length > 1);
      const scored = items
        .map((i) => {
          const text =
            `${i.title} ${i.content} ${i.tags.join(" ")}`.toLowerCase();
          const matchCount = terms.filter((t) => text.includes(t)).length;
          if (matchCount === 0) return null;

          const relevance = matchCount / terms.length;
          const daysSince = i.lastReinforcedAt
            ? (Date.now() - new Date(i.lastReinforcedAt).getTime()) /
              (1000 * 60 * 60 * 24)
            : (Date.now() - new Date(i.createdAt).getTime()) /
              (1000 * 60 * 60 * 24);
          const recencyBoost = 1 / (1 + daysSince * 0.01);
          const score = i.confidence * relevance * recencyBoost;

          return { insight: i, score };
        })
        .filter(Boolean) as Array<{ insight: Insight; score: number }>;

      scored.sort((a, b) => b.score - a.score);

      const dedupedScored: typeof scored = [];
      for (const s of scored) {
        if (dedupedScored.some((d) => d.insight.project === s.insight.project && sameInsightTitle(d.insight.title, s.insight.title))) {
          continue;
        }
        dedupedScored.push(s);
      }

      try {
        await recordAudit(kv, "insight_search", "mem::insight-search", [], {
          query: data.query,
          resultCount: dedupedScored.length,
        });
      } catch {}

      return {
        success: true,
        insights: dedupedScored.slice(0, limit).map((s) => ({
          ...s.insight,
          score: Math.round(s.score * 1000) / 1000,
        })),
      };
    },
  );

  sdk.registerFunction("mem::insight-decay-sweep", 
    async () => {
      const items = await kv.list<Insight>(KV.insights);
      let decayed = 0;
      let softDeleted = 0;
      const now = Date.now();
      const timestamp = new Date().toISOString();
      const dirty: Insight[] = [];

      for (const insight of items) {
        if (insight.deleted) continue;

        const baseline =
          insight.lastDecayedAt ||
          insight.lastReinforcedAt ||
          insight.createdAt;
        const weeksSince =
          (now - new Date(baseline).getTime()) / (1000 * 60 * 60 * 24 * 7);

        if (weeksSince < 1) continue;

        const decay = insight.decayRate * weeksSince;
        const newConfidence = Math.max(0.05, insight.confidence - decay);

        if (newConfidence !== insight.confidence) {
          insight.confidence = Math.round(newConfidence * 1000) / 1000;
          insight.lastDecayedAt = timestamp;
          insight.updatedAt = timestamp;

          if (insight.confidence <= 0.1 && insight.reinforcements === 0) {
            insight.deleted = true;
            softDeleted++;
          } else {
            decayed++;
          }

          dirty.push(insight);
        }
      }

      await Promise.all(dirty.map((i) => kv.set(KV.insights, i.id, i)));
      await recordAudit(kv, "reflect", "mem::insight-decay-sweep", dirty.map((i) => i.id), {
        event: "insight.decay",
        decayed,
        softDeleted,
        total: items.length,
        timestamp,
      });

      return { success: true, decayed, softDeleted, total: items.length };
    },
  );
}
