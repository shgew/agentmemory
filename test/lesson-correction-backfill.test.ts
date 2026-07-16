import { beforeEach, describe, expect, it } from "vitest";
import { backfillLessonCorrections } from "../src/functions/lesson-corrections.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { registerVerifyFunction } from "../src/functions/verify.js";
import { KV } from "../src/state/schema.js";
import type { AuditEntry, Lesson } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const OBSOLETE_ID = "lsn_559d51303e2a617f";
const CORRECTION_ID = "lsn_e5f50d81e47afdc2";

function makeLesson(id: string, content: string): Lesson {
  const now = "2026-06-27T11:01:38.358Z";
  return {
    id,
    content,
    context: "",
    confidence: 0.7,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    project: "agentmemory",
    tags: [],
    createdAt: now,
    updatedAt: now,
    decayRate: 0.05,
  };
}

describe("Historical lesson correction backfill", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerLessonsFunctions(sdk as never, kv as never);
    registerVerifyFunction(sdk as never, kv as never);
    await kv.set(
      KV.lessons,
      OBSOLETE_ID,
      makeLesson(OBSOLETE_ID, "Set MALLOC_ARENA_MAX=2 for iii-engine."),
    );
    await kv.set(
      KV.lessons,
      CORRECTION_ID,
      makeLesson(CORRECTION_ID, "Use the verified jemalloc hardening configuration."),
    );
  });

  it("characterizes the confirmed historical pair as unlinked before backfill", async () => {
    const obsolete = (await sdk.trigger("mem::verify", {
      id: OBSOLETE_ID,
    })) as { correctionChain: unknown[]; correctedBy: unknown[] };
    const correction = (await sdk.trigger("mem::verify", {
      id: CORRECTION_ID,
    })) as { correctionChain: unknown[]; corrects: unknown[] };

    expect(obsolete.correctionChain).toEqual([]);
    expect(obsolete.correctedBy).toEqual([]);
    expect(correction.correctionChain).toEqual([]);
    expect(correction.corrects).toEqual([]);
  });

  it("links the confirmed historical pair through the registered backfill", async () => {
    const result = (await sdk.trigger("mem::lesson-correction-backfill", {
      dryRun: false,
    })) as {
      success: boolean;
      applied: Array<{
        correctionId: string;
        correctedId: string;
        source: string;
      }>;
    };

    const obsolete = (await sdk.trigger("mem::verify", {
      id: OBSOLETE_ID,
    })) as {
      correctedBy: Array<{ lesson: Lesson }>;
    };
    const correction = (await sdk.trigger("mem::verify", {
      id: CORRECTION_ID,
    })) as {
      corrects: Array<{ lesson: Lesson }>;
    };

    expect(result.success).toBe(true);
    expect(result.applied).toEqual([
      expect.objectContaining({
        correctionId: CORRECTION_ID,
        correctedId: OBSOLETE_ID,
        source: "confirmed",
      }),
    ]);
    expect(obsolete.correctedBy[0]?.lesson.id).toBe(CORRECTION_ID);
    expect(correction.corrects[0]?.lesson.id).toBe(OBSOLETE_ID);
    expect(await kv.list<Lesson>(KV.lessons)).toHaveLength(2);
    expect((await kv.get<Lesson>(KV.lessons, CORRECTION_ID))?.confidence).toBe(0.7);
    expect((await kv.get<Lesson>(KV.lessons, CORRECTION_ID))?.reinforcements).toBe(0);
  });

  it("finds exact prose markers in dry-run mode without mutating lessons", async () => {
    const markerCorrectionId = "lsn_marker_correction";
    await kv.set(
      KV.lessons,
      markerCorrectionId,
      makeLesson(
        markerCorrectionId,
        `CORRECTION (supersedes the old allocator claim in ${OBSOLETE_ID}): use measured settings.`,
      ),
    );

    const result = (await sdk.trigger("mem::lesson-correction-backfill", {
      dryRun: true,
    })) as {
      dryRun: boolean;
      explicitMarkerPairs: Array<{ correctionId: string; correctedId: string }>;
      wouldApply: Array<{ correctionId: string; correctedId: string }>;
      applied: unknown[];
    };

    expect(result.dryRun).toBe(true);
    expect(result.explicitMarkerPairs).toContainEqual(
      expect.objectContaining({
        correctionId: markerCorrectionId,
        correctedId: OBSOLETE_ID,
      }),
    );
    expect(result.wouldApply).toHaveLength(2);
    expect(result.applied).toEqual([]);
    expect(
      (await kv.get<Lesson>(KV.lessons, markerCorrectionId))?.corrects,
    ).toBeUndefined();
  });

  it("does not duplicate correction links or provenance when run twice", async () => {
    const first = (await sdk.trigger("mem::lesson-correction-backfill", {
      dryRun: false,
    })) as { applied: unknown[] };
    const second = (await sdk.trigger("mem::lesson-correction-backfill", {
      dryRun: false,
    })) as { applied: unknown[]; alreadyLinked: unknown[] };
    const correction = await kv.get<Lesson>(KV.lessons, CORRECTION_ID);
    const audits = await kv.list<AuditEntry>(KV.audit);

    expect(first.applied).toHaveLength(1);
    expect(second.applied).toEqual([]);
    expect(second.alreadyLinked).toHaveLength(1);
    expect(
      correction?.corrects?.filter((lessonId) => lessonId === OBSOLETE_ID),
    ).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(
      expect.objectContaining({
        operation: "lesson_strengthen",
        functionId: "mem::lesson-correction-backfill",
        targetIds: [CORRECTION_ID, OBSOLETE_ID],
      }),
    );
  });

  it("skips an explicit marker whose target lesson does not exist", async () => {
    const correctionId = "lsn_deadbeef00000001";
    const missingId = "lsn_deadbeef00000002";
    await kv.set(
      KV.lessons,
      correctionId,
      makeLesson(correctionId, `CORRECTS ${missingId}: use the current API.`),
    );

    const result = await backfillLessonCorrections(kv as never, {
      dryRun: false,
      confirmedPairs: [],
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        correctionId,
        correctedId: missingId,
        reason: "correction target not found",
      }),
    );
    expect((await kv.get<Lesson>(KV.lessons, correctionId))?.corrects).toBeUndefined();
  });

  it("reports exact cross-project claims instead of applying them", async () => {
    const targetId = "lsn_deadbeef00000003";
    const correctionId = "lsn_deadbeef00000004";
    await kv.set(
      KV.lessons,
      targetId,
      { ...makeLesson(targetId, "Old guidance"), project: "ios-main" },
    );
    await kv.set(
      KV.lessons,
      correctionId,
      {
        ...makeLesson(correctionId, `CORRECTION to ${targetId}: new guidance.`),
        project: "design-system",
      },
    );

    const result = await backfillLessonCorrections(kv as never, {
      dryRun: false,
      confirmedPairs: [],
    });

    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        correctionId,
        correctedId: targetId,
        reason: "correction targets must use the same project scope",
      }),
    );
  });

  it("ignores lesson references without an explicit correction marker", async () => {
    const correctionId = "lsn_deadbeef00000005";
    await kv.set(
      KV.lessons,
      correctionId,
      makeLesson(
        correctionId,
        `Current allocator notes discuss ${OBSOLETE_ID} and use similar terminology.`,
      ),
    );

    const result = await backfillLessonCorrections(kv as never, {
      dryRun: false,
      confirmedPairs: [],
    });

    expect(result.explicitMarkerPairs).toEqual([]);
    expect(result.applied).toEqual([]);
  });
});
