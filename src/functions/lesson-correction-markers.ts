import type { Lesson } from "../types.js";

const LESSON_ID_PATTERN = /\blsn_[a-z0-9]+\b/gi;
const EXPLICIT_CORRECTION_MARKER = /\b(?:correction(?:\/refinement)?(?:\s+to)?|corrects(?:\/(?:completes|reinforces))?|correcting(?:\s+earlier\s+lesson)?|supersed(?:e|es|ed|ing)|refines\/overrides|overrides?|replaces?|reinforces\+corrects)\b/i;
const BREAKS_PRIOR_GUIDANCE_MARKER = /\bbreaks\b[^.!?\n]{0,240}\b(?:old|prior)\b/i;
const STATEMENT_SEPARATOR = /\n+|(?<=[.!?])\s+(?=[A-Z`])/;

export type LessonCorrectionCandidateSource =
  | "content"
  | "context"
  | "tag"
  | "confirmed";

export interface LessonCorrectionCandidate {
  readonly correctionId: string;
  readonly correctedId: string;
  readonly source: LessonCorrectionCandidateSource;
  readonly evidence: string;
}

export interface LessonCorrectionSkipped extends LessonCorrectionCandidate {
  readonly reason: string;
}

export const CONFIRMED_HISTORICAL_LESSON_CORRECTIONS = [
  {
    correctionId: "lsn_e5f50d81e47afdc2",
    correctedId: "lsn_559d51303e2a617f",
    source: "confirmed",
    evidence: "Task 2 confirmed historical correction pair",
  },
] as const satisfies readonly LessonCorrectionCandidate[];

export function findExplicitLessonCorrectionCandidates(
  lessons: readonly Lesson[],
): LessonCorrectionCandidate[] {
  const candidates: LessonCorrectionCandidate[] = [];
  for (const lesson of lessons) {
    candidates.push(...extractCandidates(lesson, lesson.content, "content"));
    candidates.push(...extractCandidates(lesson, lesson.context, "context"));
    for (const tag of lesson.tags) {
      candidates.push(...extractCandidates(lesson, tag, "tag"));
    }
  }
  return deduplicateLessonCorrectionCandidates(candidates);
}

export function deduplicateLessonCorrectionCandidates(
  candidates: readonly LessonCorrectionCandidate[],
): LessonCorrectionCandidate[] {
  return [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.correctionId}->${candidate.correctedId}`,
        candidate,
      ]),
    ).values(),
  ];
}

function extractCandidates(
  lesson: Lesson,
  text: string,
  source: Exclude<LessonCorrectionCandidateSource, "confirmed">,
): LessonCorrectionCandidate[] {
  const candidates: LessonCorrectionCandidate[] = [];
  for (const statement of text.split(STATEMENT_SEPARATOR)) {
    const marker =
      EXPLICIT_CORRECTION_MARKER.exec(statement) ??
      BREAKS_PRIOR_GUIDANCE_MARKER.exec(statement);
    if (!marker) continue;
    const ids = statement.slice(marker.index).match(LESSON_ID_PATTERN) ?? [];
    for (const correctedId of new Set(ids)) {
      if (correctedId === lesson.id) continue;
      candidates.push({
        correctionId: lesson.id,
        correctedId,
        source,
        evidence: statement.trim().slice(0, 500),
      });
    }
  }
  return candidates;
}
