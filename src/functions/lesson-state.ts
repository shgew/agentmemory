import type { StateKV } from "../state/kv.js";
import { fingerprintId, jaccardSimilarity, KV } from "../state/schema.js";
import { stem } from "../state/stemmer.js";
import type { Lesson } from "../types.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

export const LESSON_NEAR_DUPLICATE_THRESHOLD = 0.7;

export interface LessonSaveInput {
  content: string;
  context?: string;
  confidence?: number;
  project?: string;
  tags?: string[];
  source?: "crystal" | "manual" | "consolidation";
  sourceIds?: string[];
  corrects?: string[];
}

export type LessonSaveResult =
  | {
      success: true;
      action: "created";
      lesson: Lesson;
    }
  | {
      success: true;
      action: "strengthened";
      match: "exact" | "legacy-exact" | "near-duplicate";
      similarity?: number;
      lesson: Lesson;
    }
  | {
      success: false;
      error: string;
    };

export function sameLessonProject(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return left === right;
}

export function reinforceLesson(lesson: Lesson): void {
  const now = new Date().toISOString();
  lesson.reinforcements++;
  lesson.confidence = Math.min(
    1,
    lesson.confidence + 0.1 * (1 - lesson.confidence),
  );
  lesson.lastReinforcedAt = now;
  lesson.updatedAt = now;
}

export function filterSupersededLessons(lessons: Lesson[]): Lesson[] {
  const active = lessons.filter((lesson) => !lesson.deleted);
  const byId = new Map(active.map((lesson) => [lesson.id, lesson]));
  const supersededIds = new Set<string>();

  for (const correction of active) {
    for (const correctedId of correction.corrects ?? []) {
      const corrected = byId.get(correctedId);
      if (corrected && sameLessonProject(correction.project, corrected.project)) {
        supersededIds.add(correctedId);
      }
    }
  }

  return active.filter((lesson) => !supersededIds.has(lesson.id));
}

export function lessonContentSimilarity(left: string, right: string): number {
  return jaccardSimilarity(normalizeForSimilarity(left), normalizeForSimilarity(right));
}

export function withLessonWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  return withKeyedLock("lessons:write", operation);
}

export async function saveLesson(
  kv: StateKV,
  data: LessonSaveInput,
): Promise<LessonSaveResult> {
  if (!data || typeof data.content !== "string") {
    return { success: false, error: "content is required" };
  }
  for (const [field, value] of [
    ["tags", data.tags],
    ["sourceIds", data.sourceIds],
    ["corrects", data.corrects],
  ] as const) {
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string" || !entry.trim()))
    ) {
      return { success: false, error: `${field} must be an array of strings` };
    }
  }
  if (data.context !== undefined && typeof data.context !== "string") {
    return { success: false, error: "context must be a string" };
  }
  if (data.project !== undefined && typeof data.project !== "string") {
    return { success: false, error: "project must be a string" };
  }
  if (
    data.confidence !== undefined &&
    (typeof data.confidence !== "number" ||
      !Number.isFinite(data.confidence))
  ) {
    return { success: false, error: "confidence must be a finite number" };
  }
  if (
    data.source !== undefined &&
    !["crystal", "manual", "consolidation"].includes(data.source)
  ) {
    return { success: false, error: "source must be crystal, manual, or consolidation" };
  }

  return withLessonWriteLock(() => saveLessonUnlocked(kv, data));
}

async function saveLessonUnlocked(
  kv: StateKV,
  data: LessonSaveInput,
): Promise<LessonSaveResult> {
  const content = data.content.trim();
  if (!content) {
    return { success: false, error: "content is required" };
  }
  const project = data.project?.trim() || undefined;
  const normalizedContent = content.toLowerCase();
  const correctionIds = uniqueStrings(data.corrects ?? []);
  const projectAwareId = fingerprintId(
    "lsn",
    `${project ?? ""}\n${normalizedContent}`,
  );
  const legacyId = fingerprintId("lsn", normalizedContent);
  const [projectAware, legacy] = await Promise.all([
    kv.get<Lesson>(KV.lessons, projectAwareId),
    legacyId === projectAwareId
      ? Promise.resolve(null)
      : kv.get<Lesson>(KV.lessons, legacyId),
  ]);

  let match: "exact" | "legacy-exact" | "near-duplicate" | undefined;
  let existing: Lesson | undefined;
  let similarity: number | undefined;

  if (
    projectAware &&
    !projectAware.deleted &&
    sameLessonProject(projectAware.project, project)
  ) {
    existing = projectAware;
    match = "exact";
  } else if (
    legacy &&
    !legacy.deleted &&
    sameLessonProject(legacy.project, project)
  ) {
    existing = legacy;
    match = "legacy-exact";
  }

  let lessons: Lesson[] | undefined;
  if (!existing || (data.corrects?.length ?? 0) > 0) {
    lessons = await kv.list<Lesson>(KV.lessons);
  }

  if (!existing) {
    let bestSimilarity = LESSON_NEAR_DUPLICATE_THRESHOLD;
    for (const candidate of lessons ?? []) {
      if (candidate.deleted || !sameLessonProject(candidate.project, project)) continue;
      if (correctionIds.includes(candidate.id)) continue;
      const candidateSimilarity = lessonContentSimilarity(content, candidate.content);
      if (candidateSimilarity >= bestSimilarity) {
        bestSimilarity = candidateSimilarity;
        existing = candidate;
        match = "near-duplicate";
        similarity = candidateSimilarity;
      }
    }
  }

  const candidateId = existing?.id ?? projectAwareId;
  const proposedCorrects = uniqueStrings([
    ...(existing?.corrects ?? []),
    ...correctionIds,
  ]);
  if (correctionIds.length > 0) {
    const validation = validateCorrections(
      candidateId,
      project,
      proposedCorrects,
      lessons ?? (await kv.list<Lesson>(KV.lessons)),
    );
    if (validation) return validation;
  }

  if (existing && match) {
    reinforceLesson(existing);
    if (data.context && !existing.context) existing.context = data.context.trim();
    existing.sourceIds = uniqueStrings([...existing.sourceIds, ...(data.sourceIds ?? [])]);
    existing.tags = uniqueStrings([...existing.tags, ...(data.tags ?? [])]);
    if (proposedCorrects.length > 0) existing.corrects = proposedCorrects;
    await kv.set(KV.lessons, existing.id, existing);
    return {
      success: true,
      action: "strengthened",
      match,
      ...(similarity === undefined ? {} : { similarity }),
      lesson: existing,
    };
  }

  const confidence =
    typeof data.confidence === "number" &&
    data.confidence >= 0 &&
    data.confidence <= 1
      ? data.confidence
      : 0.5;
  const now = new Date().toISOString();
  const lesson: Lesson = {
    id: projectAwareId,
    content,
    context: data.context?.trim() || "",
    confidence,
    reinforcements: 0,
    source: data.source || "manual",
    sourceIds: data.sourceIds || [],
    project,
    tags: data.tags || [],
    createdAt: now,
    updatedAt: now,
    decayRate: 0.05,
    ...(proposedCorrects.length === 0 ? {} : { corrects: proposedCorrects }),
  };

  await kv.set(KV.lessons, lesson.id, lesson);
  return { success: true, action: "created", lesson };
}

function normalizeForSimilarity(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(stem)
    .join(" ");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function validateCorrections(
  candidateId: string,
  project: string | undefined,
  corrects: string[],
  lessons: Lesson[],
): Extract<LessonSaveResult, { success: false }> | null {
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  for (const correctedId of corrects) {
    const corrected = byId.get(correctedId);
    if (!corrected) {
      return {
        success: false,
        error: `correction target not found: ${correctedId}`,
      };
    }
    if (!sameLessonProject(corrected.project, project)) {
      return {
        success: false,
        error: `correction targets must use the same project scope: ${correctedId}`,
      };
    }
  }

  const stack = corrects.slice();
  const visited = new Set<string>();
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId) continue;
    if (currentId === candidateId) {
      return { success: false, error: "correction cycle detected" };
    }
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const current = byId.get(currentId);
    if (current) stack.push(...(current.corrects ?? []));
  }

  return null;
}
