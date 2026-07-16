import { describe, expect, it } from "vitest";
import { backfillLessonCorrections } from "../src/functions/lesson-corrections.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { KV } from "../src/state/schema.js";
import type { Lesson } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function makeLesson(
  id: string,
  content: string,
  confidence: number,
): Lesson {
  const now = "2026-06-27T11:01:38.358Z";
  return {
    id,
    content,
    context: "",
    confidence,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    project: "benchmark",
    tags: [],
    createdAt: now,
    updatedAt: now,
    decayRate: 0.05,
  };
}

describe("Historical lesson correction backfill ranking", () => {
  it("ranks the correction first for at least 95 percent of 30 marker pairs", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerLessonsFunctions(sdk as never, kv as never);
    const pairs: Array<{
      obsoleteId: string;
      correctionId: string;
      query: string;
    }> = [];

    for (let index = 0; index < 30; index++) {
      const suffix = index.toString(16).padStart(16, "0");
      const correctionSuffix = (index + 256).toString(16).padStart(16, "0");
      const obsoleteId = `lsn_${suffix}`;
      const correctionId = `lsn_${correctionSuffix}`;
      const query = `allocator${index} runtime${index} recommendation${index}`;
      await kv.set(
        KV.lessons,
        obsoleteId,
        makeLesson(
          obsoleteId,
          `${query} requires unsafe${index} defaults everywhere`,
          0.95,
        ),
      );
      await kv.set(
        KV.lessons,
        correctionId,
        makeLesson(
          correctionId,
          `CORRECTION (supersedes the claim in ${obsoleteId}): ${query} requires measured${index} evidence`,
          0.4,
        ),
      );
      pairs.push({ obsoleteId, correctionId, query });
    }

    const backfill = await backfillLessonCorrections(kv as never, {
      dryRun: false,
      confirmedPairs: [],
    });
    let correctionsFirst = 0;
    for (const pair of pairs) {
      const recalled = (await sdk.trigger("mem::lesson-recall", {
        query: pair.query,
        project: "benchmark",
      })) as { lessons: Lesson[] };
      if (
        recalled.lessons[0]?.id === pair.correctionId &&
        !recalled.lessons.some((lesson) => lesson.id === pair.obsoleteId)
      ) {
        correctionsFirst++;
      }
    }

    expect(backfill.explicitMarkerPairs).toHaveLength(30);
    expect(backfill.applied).toHaveLength(30);
    expect(correctionsFirst / pairs.length).toBeGreaterThanOrEqual(0.95);
  });
});
