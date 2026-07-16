import type { ISdk } from "iii-sdk";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  Session,
  Memory,
  MemoryProvider,
} from "../types.js";
import { KV, fingerprintId, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
  PROCEDURAL_EXTRACTION_SYSTEM,
  buildProceduralExtractionPrompt,
} from "../prompts/consolidation.js";
import { recordAudit } from "./audit.js";
import {
  getConsolidationDecayDays,
  getEnvVar,
  isConsolidationEnabled,
  isInsightSynthesisEnabled,
  isProceduralExtractionEnabled,
} from "../config.js";
import { logger } from "../logger.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

interface ProjectEvidence {
  sessionIds: Set<string>;
  memoryIds: Set<string>;
  memories: Memory[];
}

function memoryBelongsToProject(
  memory: Memory,
  project: string,
  projectSessionIds: Set<string>,
): boolean {
  if (memory.project !== undefined) return memory.project === project;
  return memory.sessionIds.some((sessionId) => projectSessionIds.has(sessionId));
}

async function readProjectEvidence(
  kv: StateKV,
  project: string,
): Promise<ProjectEvidence> {
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
  const scopedMemories = memories.filter((memory) =>
    memoryBelongsToProject(memory, project, sessionIds),
  );
  return {
    sessionIds,
    memoryIds: new Set(scopedMemories.map((memory) => memory.id)),
    memories: scopedMemories,
  };
}

function semanticBelongsToProject(
  semantic: SemanticMemory,
  evidence: ProjectEvidence,
): boolean {
  return (
    semantic.sourceSessionIds.some((id) => evidence.sessionIds.has(id)) ||
    semantic.sourceMemoryIds.some((id) => evidence.memoryIds.has(id))
  );
}

function proceduralBelongsToProject(
  procedural: ProceduralMemory,
  evidence: ProjectEvidence,
): boolean {
  return procedural.sourceSessionIds.some((id) => evidence.sessionIds.has(id));
}

function unionIds(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

function applyDecay(
  items: Array<{
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
  }>,
  decayDays: number,
): void {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return;
  const now = Date.now();
  for (const item of items) {
    const lastAccess = item.lastAccessedAt || item.updatedAt;
    const daysSince =
      (now - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      item.strength = Math.max(
        0.1,
        item.strength * Math.pow(0.9, decayPeriods),
      );
    }
  }
}

export function registerConsolidationPipelineFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::consolidate-pipeline",
    async (data?: { tier?: string; force?: boolean; project?: string }) =>
      withKeyedLock("consolidation:pipeline", async () => {
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / MINIMAX_API_KEY / OPENAI_BASE_URL / AGENTMEMORY_PROVIDER=agent-sdk)" };
      }
      const tier = data?.tier || "all";
      const decayDays = getConsolidationDecayDays();
      const results: Record<string, unknown> = {};
      const project = data?.project;
      const projectEvidence =
        project && tier !== "reflect"
          ? await readProjectEvidence(kv, project)
          : undefined;

      if (tier === "all" || tier === "semantic") {
        let summaries = await kv.list<SessionSummary>(KV.summaries);
        let existingSemantic = await kv.list<SemanticMemory>(KV.semantic);
        if (project && projectEvidence) {
          summaries = summaries.filter((summary) => summary.project === project);
          existingSemantic = existingSemantic.filter((semantic) =>
            semanticBelongsToProject(semantic, projectEvidence),
          );
        }

        if (summaries.length >= 5) {
          const recentSummaries = summaries
            .sort(
              (a, b) =>
                b.createdAt.localeCompare(a.createdAt) ||
                a.sessionId.localeCompare(b.sessionId),
            )
            .slice(0, 20);
          const semanticInputFingerprint = fingerprintId(
            "semantic-input",
            JSON.stringify(
              recentSummaries.map((summary) => ({
                sessionId: summary.sessionId,
                createdAt: summary.createdAt,
                observationCount: summary.observationCount,
                title: summary.title,
                narrative: summary.narrative,
                concepts: summary.concepts,
              })),
            ),
          );
          const semanticScope =
            project === undefined ? "global" : `project:${project}`;
          const semanticWatermarkKey = `semantic:last-input:${semanticScope}`;
          const semanticWatermark = data?.force
            ? null
            : await kv.get<{ fingerprint: string }>(
                KV.config,
                semanticWatermarkKey,
              );
          if (semanticWatermark?.fingerprint === semanticInputFingerprint) {
            results.semantic = {
              skipped: true,
              reason: "summaries unchanged",
            };
          } else {
            const prompt = buildSemanticMergePrompt(
              recentSummaries.map((s) => ({
                title: s.title,
                narrative: s.narrative,
                concepts: s.concepts,
              })),
            );

            try {
              const response = await provider.summarize(
                SEMANTIC_MERGE_SYSTEM,
                prompt,
              );

              const factRegex =
                /<fact\s+confidence="([^"]+)">([^<]+)<\/fact>/g;
              let match;
              let newFacts = 0;
              const now = new Date().toISOString();

              while ((match = factRegex.exec(response)) !== null) {
                const parsedConf = parseFloat(match[1]);
                const confidence = Number.isNaN(parsedConf) ? 0.5 : parsedConf;
                const fact = match[2].trim();

                const existing = existingSemantic.find(
                  (s) => s.fact.toLowerCase() === fact.toLowerCase(),
                );
                if (existing) {
                  existing.accessCount++;
                  existing.lastAccessedAt = now;
                  existing.updatedAt = now;
                  existing.confidence = Math.max(
                    existing.confidence,
                    confidence,
                  );
                  existing.sourceSessionIds = unionIds(
                    existing.sourceSessionIds,
                    recentSummaries.map((summary) => summary.sessionId),
                  );
                  await kv.set(KV.semantic, existing.id, existing);
                } else {
                  const sem: SemanticMemory = {
                    id: generateId("sem"),
                    fact,
                    confidence,
                    sourceSessionIds: recentSummaries.map((s) => s.sessionId),
                    sourceMemoryIds: [],
                    accessCount: 1,
                    lastAccessedAt: now,
                    strength: confidence,
                    createdAt: now,
                    updatedAt: now,
                  };
                  await kv.set(KV.semantic, sem.id, sem);
                  newFacts++;
                }
              }
              await kv.set(KV.config, semanticWatermarkKey, {
                fingerprint: semanticInputFingerprint,
              });
              results.semantic = { newFacts, totalSummaries: summaries.length };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error("Semantic consolidation failed", { error: msg });
              results.semantic = { error: msg };
            }
          }
        } else {
          results.semantic = {
            skipped: true,
            reason: "fewer than 5 summaries",
          };
        }
      }

      if ((tier === "all" || tier === "reflect") && !isInsightSynthesisEnabled()) {
        results.reflect = {
          skipped: true,
          reason: "INSIGHT_SYNTHESIS_ENABLED=false",
        };
      } else if (tier === "all" || tier === "reflect") {
        const REFLECT_GATE_MS = 24 * 60 * 60 * 1000;
        const scope = project || "global";
        const reflectWatermarkKey = `reflect:last-success:${scope}`;
        results.reflect = await withKeyedLock(
          `reflect:watermark:${scope}`,
          async () => {
            if (tier === "all") {
              const last = await kv
                .get<{ at: string }>(KV.config, reflectWatermarkKey)
                .catch(() => null);
              if (
                last?.at &&
                Date.now() - new Date(last.at).getTime() < REFLECT_GATE_MS
              ) {
                return {
                  skipped: true,
                  reason: "reflect ran within the last 24h",
                };
              }
            }
            try {
              const reflectResult = await sdk.trigger({
                function_id: "mem::reflect",
                payload: {
                  maxClusters: 10,
                  project,
                },
              });
              const rr = reflectResult as
                | { success?: boolean; fullPassComplete?: boolean }
                | null
                | undefined;
              if (rr?.success === true && rr?.fullPassComplete === true) {
                await kv.set(KV.config, reflectWatermarkKey, {
                  at: new Date().toISOString(),
                });
              }
              return reflectResult;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn("Reflect tier failed", { error: msg });
              return { error: msg };
            }
          },
        );
      }

      if (
        (tier === "all" || tier === "procedural") &&
        !isProceduralExtractionEnabled()
      ) {
        // Kill switch overrides force. Manual skill consumers
        // (mem::skill-list / mem::skill-match) are separate and unaffected.
        results.procedural = {
          skipped: true,
          reason: "PROCEDURAL_EXTRACTION_ENABLED=false",
        };
      } else if (tier === "all" || tier === "procedural") {
        const memories =
          projectEvidence?.memories ?? (await kv.list<Memory>(KV.memories));
        const patterns = memories
          .filter((m) => m.isLatest && m.type === "pattern")
          .map((memory) => {
            const sourceSessionIds =
              project && projectEvidence && memory.project === undefined
                ? memory.sessionIds.filter((id) =>
                    projectEvidence.sessionIds.has(id),
                  )
                : memory.sessionIds;
            return {
              content: memory.content,
              frequency: sourceSessionIds.length || 1,
              sourceSessionIds,
            };
          })
          .filter((p) => p.frequency >= 2);

        if (patterns.length >= 2) {
          const prompt = buildProceduralExtractionPrompt(patterns);

          try {
            const response = await provider.summarize(
              PROCEDURAL_EXTRACTION_SYSTEM,
              prompt,
            );

            const procRegex =
              /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
            let match;
            let newProcs = 0;
            const now = new Date().toISOString();
            let existingProcs = await kv.list<ProceduralMemory>(
              KV.procedural,
            );
            if (projectEvidence) {
              existingProcs = existingProcs.filter((procedural) =>
                proceduralBelongsToProject(procedural, projectEvidence),
              );
            }
            const sourceSessionIds = unionIds(
              [],
              patterns.flatMap((pattern) => pattern.sourceSessionIds),
            );

            while ((match = procRegex.exec(response)) !== null) {
              const name = match[1];
              const trigger = match[2];
              const stepsBlock = match[3];
              const steps: string[] = [];

              const stepRegex = /<step>([^<]+)<\/step>/g;
              let stepMatch;
              while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
                steps.push(stepMatch[1].trim());
              }

              const existing = existingProcs.find(
                (p) => p.name.toLowerCase() === name.toLowerCase(),
              );
              if (existing) {
                existing.frequency++;
                existing.updatedAt = now;
                existing.strength = Math.min(1, existing.strength + 0.1);
                existing.sourceSessionIds = unionIds(
                  existing.sourceSessionIds,
                  sourceSessionIds,
                );
                await kv.set(KV.procedural, existing.id, existing);
              } else {
                const proc: ProceduralMemory = {
                  id: generateId("proc"),
                  name,
                  steps,
                  triggerCondition: trigger,
                  frequency: 1,
                  sourceSessionIds,
                  strength: 0.5,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.procedural, proc.id, proc);
                newProcs++;
              }
            }
            results.procedural = {
              newProcedures: newProcs,
              patternsAnalyzed: patterns.length,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Procedural extraction failed", { error: msg });
            results.procedural = { error: msg };
          }
        } else {
          results.procedural = {
            skipped: true,
            reason: "fewer than 2 recurring patterns",
          };
        }
      }

      if (tier === "all" || tier === "decay") {
        let semantic = await kv.list<SemanticMemory>(KV.semantic);
        if (projectEvidence) {
          semantic = semantic.filter((item) =>
            semanticBelongsToProject(item, projectEvidence),
          );
        }
        applyDecay(semantic, decayDays);
        for (const s of semantic) {
          await kv.set(KV.semantic, s.id, s);
        }

        let procedural = await kv.list<ProceduralMemory>(KV.procedural);
        if (projectEvidence) {
          procedural = procedural.filter((item) =>
            proceduralBelongsToProject(item, projectEvidence),
          );
        }
        applyDecay(procedural, decayDays);
        for (const p of procedural) {
          await kv.set(KV.procedural, p.id, p);
        }

        results.decay = {
          semantic: semantic.length,
          procedural: procedural.length,
        };
      }

      if (getEnvVar("OBSIDIAN_AUTO_EXPORT") === "true") {
        try {
          await sdk.trigger({ function_id: "mem::obsidian-export", payload: {} });
          results.obsidianExport = { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Obsidian auto-export failed", { error: msg });
          results.obsidianExport = { success: false, error: msg };
        }
      }

      await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", [], {
        tier,
        results,
      });

      logger.info("Consolidation pipeline complete", { tier, results });
      return { success: true, results };
      }),
  );
}
