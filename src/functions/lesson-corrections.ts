import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Lesson } from "../types.js";
import { sameLessonProject } from "./lesson-state.js";

export type LessonCorrectionDirection = "corrects" | "correctedBy";

export interface LessonCorrectionLink {
  lesson: Lesson;
  hop: number;
  direction: LessonCorrectionDirection;
}

export function traceLessonCorrections(
  lessons: Lesson[],
  startId: string,
  maxHops = 5,
): LessonCorrectionLink[] {
  const allById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const start = allById.get(startId);
  if (!start) return [];

  const activeById = new Map(
    lessons
      .filter((lesson) => !lesson.deleted)
      .map((lesson) => [lesson.id, lesson]),
  );
  const correctedBy = new Map<string, string[]>();
  for (const correction of activeById.values()) {
    for (const correctedId of correction.corrects ?? []) {
      const corrected = allById.get(correctedId);
      if (!corrected || !sameLessonProject(correction.project, corrected.project)) {
        continue;
      }
      const ids = correctedBy.get(correctedId) ?? [];
      ids.push(correction.id);
      correctedBy.set(correctedId, ids);
    }
  }

  const visited = new Set([startId]);
  const queue: Array<{
    id: string;
    hop: number;
    direction: LessonCorrectionDirection;
  }> = [];
  enqueueLinks(start, 1, queue, activeById, correctedBy);
  const result: LessonCorrectionLink[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.hop > maxHops || visited.has(current.id)) continue;
    const lesson = activeById.get(current.id);
    if (!lesson) continue;
    visited.add(current.id);
    result.push({ lesson, hop: current.hop, direction: current.direction });
    enqueueLinks(lesson, current.hop + 1, queue, activeById, correctedBy);
  }

  return result;
}

export async function getRelatedLessonResult(
  kv: StateKV,
  lessonId: string,
  maxHops: number,
  minConfidence: number,
): Promise<{
  results: Array<LessonCorrectionLink & { confidence: number }>;
} | null> {
  const lesson = await kv.get<Lesson>(KV.lessons, lessonId);
  if (!lesson) return null;
  const links = traceLessonCorrections(
    await kv.list<Lesson>(KV.lessons),
    lessonId,
    maxHops,
  );
  return {
    results: links
      .filter((link) => link.lesson.confidence >= minConfidence)
      .map((link) => ({ ...link, confidence: link.lesson.confidence })),
  };
}

function enqueueLinks(
  lesson: Lesson,
  hop: number,
  queue: Array<{
    id: string;
    hop: number;
    direction: LessonCorrectionDirection;
  }>,
  activeById: Map<string, Lesson>,
  correctedBy: Map<string, string[]>,
): void {
  for (const correctedId of lesson.corrects ?? []) {
    const corrected = activeById.get(correctedId);
    if (corrected && sameLessonProject(lesson.project, corrected.project)) {
      queue.push({ id: correctedId, hop, direction: "corrects" });
    }
  }
  for (const correctionId of correctedBy.get(lesson.id) ?? []) {
    queue.push({ id: correctionId, hop, direction: "correctedBy" });
  }
}
