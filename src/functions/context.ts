import type { ISdk } from "iii-sdk";
import type {
  ContextBlock,
  Session,
  ProjectProfile,
  MemorySlot,
  Lesson,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordOwnedAccessBatch, type AccessTarget } from "./access-tracker.js";
import { logger } from "../logger.js";
import {
  isSlotsEnabled,
  listPinnedSlots,
  renderPinnedContext,
} from "./slots.js";
import { filterSupersededLessons } from "./lesson-state.js";
import { buildSessionContextBlocks } from "./session-context.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function registerContextFunction(
  sdk: ISdk,
  kv: StateKV,
  tokenBudget: number,
): void {
  sdk.registerFunction(
    "mem::context",
    async (data: { sessionId: string; project: string; budget?: number }) => {
      const budget = data.budget || tokenBudget;
      const blocks: ContextBlock[] = [];
      const currentSession = await kv.get<Session>(KV.sessions, data.sessionId);
      if (!currentSession) return { context: "", blocks: 0, tokens: 0 };
      const project = currentSession.project;
      const header = `<agentmemory-context project="${escapeXmlAttr(project)}">`;
      const footer = `</agentmemory-context>`;
      const wrapperTokens = estimateTokens(header) + estimateTokens(footer);
      const slotBlocks: ContextBlock[] = [];
      let profileBlockTokens = 0;

      const [pinnedSlots, profile, lessons] = await Promise.all([
        isSlotsEnabled()
          ? listPinnedSlots(kv, project).catch(() => [] as MemorySlot[])
          : Promise.resolve([] as MemorySlot[]),
        kv.get<ProjectProfile>(KV.profiles, project).catch(() => null),
        kv.list<Lesson>(KV.lessons).catch(() => [] as Lesson[]),
      ]);

      for (const slot of pinnedSlots) {
        const slotContent = renderPinnedContext([slot]);
        const slotBlock: ContextBlock = {
          type: "memory",
          content: slotContent,
          tokens: estimateTokens(slotContent),
          recency: new Date(slot.updatedAt).getTime(),
          priority: 3,
        };
        slotBlocks.push(slotBlock);
        blocks.push(slotBlock);
      }
      if (profile) {
        const profileParts = [];
        if (profile.topConcepts.length > 0) {
          profileParts.push(
            `Concepts: ${profile.topConcepts
              .slice(0, 8)
              .map((c) => c.concept)
              .join(", ")}`,
          );
        }
        if (profile.topFiles.length > 0) {
          profileParts.push(
            `Key files: ${profile.topFiles
              .slice(0, 5)
              .map((f) => f.file)
              .join(", ")}`,
          );
        }
        if (profile.conventions.length > 0) {
          profileParts.push(`Conventions: ${profile.conventions.join("; ")}`);
        }
        if (profile.commonErrors.length > 0) {
          profileParts.push(
            `Common errors: ${profile.commonErrors.slice(0, 3).join("; ")}`,
          );
        }
        if (profileParts.length > 0) {
          const profileContent = `## Project Profile\n${profileParts.join("\n")}`;
          profileBlockTokens = estimateTokens(profileContent);
          blocks.push({
            type: "memory",
            content: profileContent,
            tokens: profileBlockTokens,
            recency: new Date(profile.updatedAt).getTime(),
            priority: 2,
          });
        }
      }

      const relevantLessons = filterSupersededLessons(lessons)
        .filter((l) => !l.project || l.project === project)
        .sort((a, b) => {
          const scoreA = (a.project === project ? 1.5 : 1) * a.confidence;
          const scoreB = (b.project === project ? 1.5 : 1) * b.confidence;
          return scoreB - scoreA;
        })
        .slice(0, 10);

      if (relevantLessons.length > 0) {
        const lessonHeader = "## Lessons Learned";
        const lines = relevantLessons.map(
          (l) =>
            `- (${l.confidence.toFixed(2)}) ${l.content}${l.context ? `: ${l.context}` : ""}`,
        );
        const fullContent = `${lessonHeader}\n${lines.join("\n")}`;

        // Reserve higher-priority block capacity before fitting lessons so the
        // packing loop cannot discard the entire lessons block.
        let reservedBeforeLessons = wrapperTokens;
        for (const slotBlock of slotBlocks) {
          if (reservedBeforeLessons + slotBlock.tokens > budget) continue;
          reservedBeforeLessons += slotBlock.tokens;
        }
        if (
          profileBlockTokens > 0 &&
          reservedBeforeLessons + profileBlockTokens <= budget
        ) {
          reservedBeforeLessons += profileBlockTokens;
        }
        const lessonHardCap = budget - reservedBeforeLessons;
        const lessonSoftCap = Math.min(
          lessonHardCap,
          Math.max(500, Math.floor(budget * 0.35)),
        );

        let included = relevantLessons;
        let lessonsContent = fullContent;
        if (estimateTokens(fullContent) > lessonHardCap) {
          const chosen: Lesson[] = [];
          const chosenLines: string[] = [];
          let tokens = estimateTokens(lessonHeader);
          for (let i = 0; i < relevantLessons.length; i++) {
            const lineTokens = estimateTokens(`\n${lines[i]}`);
            if (tokens + lineTokens > lessonSoftCap) continue;
            chosen.push(relevantLessons[i]);
            chosenLines.push(lines[i]);
            tokens += lineTokens;
          }
          included = chosen;
          lessonsContent =
            chosen.length > 0
              ? `${lessonHeader}\n${chosenLines.join("\n")}`
              : "";
        }

        if (included.length > 0 && lessonsContent) {
          const mostRecent = included.reduce((acc, l) => {
            const t = new Date(l.lastReinforcedAt || l.updatedAt).getTime();
            return t > acc ? t : acc;
          }, 0);
          blocks.push({
            type: "memory",
            content: lessonsContent,
            tokens: estimateTokens(lessonsContent),
            recency: mostRecent,
            priority: 1,
            sourceIds: included.map((l) => l.id),
            sourceScope: "lesson",
          });
        }
      }

      blocks.push(
        ...(await buildSessionContextBlocks(kv, { ...data, project })),
      );

      blocks.sort((a, b) => {
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        if (pb !== pa) return pb - pa;
        return b.recency - a.recency;
      });

      let usedTokens = 0;
      const selected: string[] = [];
      const accessTargets: AccessTarget[] = [];
      usedTokens += wrapperTokens;

      for (const block of blocks) {
        if (usedTokens + block.tokens > budget) continue;
        selected.push(block.content);
        usedTokens += block.tokens;
        if (block.sourceIds && block.sourceIds.length > 0) {
          if (block.sourceScope === "lesson") {
            accessTargets.push(
              ...block.sourceIds.map((id) => ({
                id,
                scope: "lesson" as const,
              })),
            );
          } else if (
            block.sourceScope === "observation" &&
            block.sourceSessionId
          ) {
            accessTargets.push(
              ...block.sourceIds.map((id) => ({
                id,
                scope: "observation" as const,
                sessionId: block.sourceSessionId!,
              })),
            );
          }
        }
      }

      if (accessTargets.length > 0) {
        void recordOwnedAccessBatch(kv, accessTargets);
      }

      if (selected.length === 0) {
        logger.info("No context available", { project });
        return { context: "", blocks: 0, tokens: 0 };
      }

      const result = `${header}\n${selected.join("\n\n")}\n${footer}`;
      logger.info("Context generated", {
        blocks: selected.length,
        tokens: usedTokens,
      });
      return { context: result, blocks: selected.length, tokens: usedTokens };
    },
  );
}
