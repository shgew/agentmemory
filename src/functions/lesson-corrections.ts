import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Lesson } from "../types.js";
import { safeAudit } from "./audit.js";
import {
  CONFIRMED_HISTORICAL_LESSON_CORRECTIONS,
  deduplicateLessonCorrectionCandidates,
  findExplicitLessonCorrectionCandidates,
  type LessonCorrectionCandidate,
  type LessonCorrectionSkipped,
} from "./lesson-correction-markers.js";
import { sameLessonProject, validateCorrections } from "./lesson-state.js";

export type LessonCorrectionDirection = "corrects" | "correctedBy";

export interface LessonCorrectionLink {
  lesson: Lesson;
  hop: number;
  direction: LessonCorrectionDirection;
}

export interface LessonCorrectionBackfillResult {
  readonly success: true;
  readonly dryRun: boolean;
  readonly scannedLessons: number;
  readonly explicitMarkerPairs: readonly LessonCorrectionCandidate[];
  readonly confirmedPairs: readonly LessonCorrectionCandidate[];
  readonly wouldApply: readonly LessonCorrectionCandidate[];
  readonly applied: readonly LessonCorrectionCandidate[];
  readonly alreadyLinked: readonly LessonCorrectionCandidate[];
  readonly skipped: readonly LessonCorrectionSkipped[];
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

export async function backfillLessonCorrections(
  kv: StateKV,
  options: {
    readonly dryRun?: boolean;
    readonly confirmedPairs?: readonly LessonCorrectionCandidate[];
  } = {},
): Promise<LessonCorrectionBackfillResult> {
  const dryRun = options.dryRun !== false;
  const lessons = await kv.list<Lesson>(KV.lessons);
  const workingLessons = lessons.map((lesson) => ({
    ...lesson,
    ...(lesson.corrects ? { corrects: [...lesson.corrects] } : {}),
  }));
  const byId = new Map(workingLessons.map((lesson) => [lesson.id, lesson]));
  const explicitMarkerPairs = findExplicitLessonCorrectionCandidates(lessons);
  const confirmedPairs = [...(options.confirmedPairs ?? CONFIRMED_HISTORICAL_LESSON_CORRECTIONS)];
  const candidates = deduplicateLessonCorrectionCandidates([
    ...explicitMarkerPairs,
    ...confirmedPairs,
  ]);
  const wouldApply: LessonCorrectionCandidate[] = [];
  const applied: LessonCorrectionCandidate[] = [];
  const alreadyLinked: LessonCorrectionCandidate[] = [];
  const skipped: LessonCorrectionSkipped[] = [];

  for (const candidate of candidates) {
    const correction = byId.get(candidate.correctionId);
    const corrected = byId.get(candidate.correctedId);
    if (!correction || correction.deleted) {
      skipped.push({ ...candidate, reason: "correction lesson not found or deleted" });
      continue;
    }
    if (!corrected) {
      skipped.push({ ...candidate, reason: "correction target not found" });
      continue;
    }
    if (!sameLessonProject(correction.project, corrected.project)) {
      skipped.push({ ...candidate, reason: "correction targets must use the same project scope" });
      continue;
    }
    if (correction.corrects?.includes(candidate.correctedId)) {
      alreadyLinked.push(candidate);
      continue;
    }

    const proposedCorrects = [...new Set([...(correction.corrects ?? []), candidate.correctedId])];
    const validation = validateCorrections(
      correction.id,
      correction.project,
      proposedCorrects,
      workingLessons,
    );
    if (validation) {
      skipped.push({ ...candidate, reason: validation.error });
      continue;
    }

    correction.corrects = proposedCorrects;
    if (dryRun) {
      wouldApply.push(candidate);
      continue;
    }

    correction.updatedAt = new Date().toISOString();
    await kv.set(KV.lessons, correction.id, correction);
    await safeAudit(
      kv,
      "lesson_strengthen",
      "mem::lesson-correction-backfill",
      [correction.id, candidate.correctedId],
      { action: "correction-link", source: candidate.source, evidence: candidate.evidence },
    );
    applied.push(candidate);
  }

  return {
    success: true,
    dryRun,
    scannedLessons: lessons.length,
    explicitMarkerPairs,
    confirmedPairs,
    wouldApply,
    applied,
    alreadyLinked,
    skipped,
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
