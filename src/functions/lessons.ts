import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Lesson } from "../types.js";
import { recordAudit, safeAudit } from "./audit.js";
import { backfillLessonCorrections } from "./lesson-corrections.js";
import {
  filterSupersededLessons,
  reinforceLesson,
  saveLesson,
  type LessonSaveInput,
} from "./lesson-state.js";

export function registerLessonsFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::lesson-correction-backfill",
    async (data: { dryRun?: boolean } = {}) => {
      if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") {
        return { success: false, error: "dryRun must be a boolean" };
      }
      return backfillLessonCorrections(kv, { dryRun: data.dryRun });
    },
  );

  sdk.registerFunction("mem::lesson-save", 
    async (data: LessonSaveInput) => {
      const result = await saveLesson(kv, data);
      if (!result.success) return result;

      await safeAudit(
        kv,
        result.action === "created" ? "lesson_save" : "lesson_strengthen",
        "mem::lesson-save",
        [result.lesson.id],
        result.action === "strengthened" ? { match: result.match } : {},
      );

      return result;
    },
  );

  sdk.registerFunction("mem::lesson-recall", 
    async (data: {
      query: string;
      project?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      if (!data.query?.trim()) {
        return { success: false, error: "query is required" };
      }

      const query = data.query.toLowerCase();
      const minConfidence = data.minConfidence ?? 0.1;
      const limit = data.limit ?? 10;

      let lessons = filterSupersededLessons(await kv.list<Lesson>(KV.lessons));

      lessons = lessons.filter((l) => l.confidence >= minConfidence);

      if (data.project) {
        lessons = lessons.filter((l) => l.project === data.project);
      }

      const scored = lessons
        .map((l) => {
          const text = `${l.content} ${l.context} ${l.tags.join(" ")}`.toLowerCase();
          const terms = query.split(/\s+/).filter((t) => t.length > 1);
          const matchCount = terms.filter((t) => text.includes(t)).length;
          if (matchCount === 0) return null;

          const relevance = matchCount / terms.length;
          const daysSinceReinforced = l.lastReinforcedAt
            ? (Date.now() - new Date(l.lastReinforcedAt).getTime()) /
              (1000 * 60 * 60 * 24)
            : (Date.now() - new Date(l.createdAt).getTime()) /
              (1000 * 60 * 60 * 24);
          const recencyBoost = 1 / (1 + daysSinceReinforced * 0.01);
          const score = l.confidence * relevance * recencyBoost;

          return { lesson: l, score };
        })
        .filter(Boolean) as Array<{ lesson: Lesson; score: number }>;

      scored.sort((a, b) => b.score - a.score);

      await safeAudit(kv, "lesson_recall", "mem::lesson-recall", [], {
        query: data.query,
        resultCount: scored.length,
      });

      return {
        success: true,
        lessons: scored.slice(0, limit).map((s) => ({
          ...s.lesson,
          score: Math.round(s.score * 1000) / 1000,
        })),
      };
    },
  );

  sdk.registerFunction("mem::lesson-list", 
    async (data: {
      project?: string;
      source?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      const limit = data.limit ?? 50;
      const minConfidence = data.minConfidence ?? 0;
      let lessons = filterSupersededLessons(await kv.list<Lesson>(KV.lessons));

      lessons = lessons.filter((l) => l.confidence >= minConfidence);

      if (data.project) {
        lessons = lessons.filter((l) => l.project === data.project);
      }
      if (data.source) {
        lessons = lessons.filter((l) => l.source === data.source);
      }

      lessons.sort((a, b) => b.confidence - a.confidence);

      return { success: true, lessons: lessons.slice(0, limit) };
    },
  );

  sdk.registerFunction("mem::lesson-strengthen", 
    async (data: { lessonId: string }) => {
      if (!data.lessonId) {
        return { success: false, error: "lessonId is required" };
      }

      const lesson = await kv.get<Lesson>(KV.lessons, data.lessonId);
      if (!lesson || lesson.deleted) {
        return { success: false, error: "lesson not found" };
      }

      reinforceLesson(lesson);

      await kv.set(KV.lessons, lesson.id, lesson);

      await safeAudit(kv, "lesson_strengthen", "mem::lesson-strengthen", [
        lesson.id,
      ]);

      return { success: true, lesson };
    },
  );

  sdk.registerFunction("mem::lesson-decay-sweep", 
    async () => {
      const lessons = await kv.list<Lesson>(KV.lessons);
      let decayed = 0;
      let softDeleted = 0;
      const now = Date.now();
      const timestamp = new Date().toISOString();
      const dirty: Lesson[] = [];
      const auditEvents: Array<{
        id: string;
        action: "decay" | "soft-delete";
        beforeConfidence: number;
        afterConfidence: number;
        beforeDeleted: boolean;
        afterDeleted: boolean;
      }> = [];

      for (const lesson of lessons) {
        if (lesson.deleted) continue;

        const baseline = lesson.lastDecayedAt || lesson.lastReinforcedAt || lesson.createdAt;
        const weeksSinceBaseline =
          (now - new Date(baseline).getTime()) / (1000 * 60 * 60 * 24 * 7);

        if (weeksSinceBaseline < 1) continue;

        const decay = lesson.decayRate * weeksSinceBaseline;
        const newConfidence = Math.max(0.05, lesson.confidence - decay);

        if (newConfidence !== lesson.confidence) {
          const beforeConfidence = lesson.confidence;
          const beforeDeleted = !!lesson.deleted;
          lesson.confidence = Math.round(newConfidence * 1000) / 1000;
          lesson.lastDecayedAt = timestamp;
          lesson.updatedAt = timestamp;

          if (lesson.confidence <= 0.1 && lesson.reinforcements === 0) {
            lesson.deleted = true;
            softDeleted++;
          } else {
            decayed++;
          }

          dirty.push(lesson);
          auditEvents.push({
            id: lesson.id,
            action: lesson.deleted ? "soft-delete" : "decay",
            beforeConfidence,
            afterConfidence: lesson.confidence,
            beforeDeleted,
            afterDeleted: !!lesson.deleted,
          });
        }
      }

      await Promise.all(dirty.map((l) => kv.set(KV.lessons, l.id, l)));
      await Promise.all(
        auditEvents.map((event) =>
          recordAudit(kv, "lesson_strengthen", "mem::lesson-decay-sweep", [event.id], {
            action: event.action,
            actor: "system",
            reason: "decay-sweep",
            before: {
              confidence: event.beforeConfidence,
              deleted: event.beforeDeleted,
            },
            after: {
              confidence: event.afterConfidence,
              deleted: event.afterDeleted,
            },
          }),
        ),
      );

      return { success: true, decayed, softDeleted, total: lessons.length };
    },
  );
}
