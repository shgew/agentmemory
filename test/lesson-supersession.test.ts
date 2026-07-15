import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerLessonsFunctions } from "../src/functions/lessons.js";
import type { Lesson } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("Lesson supersession", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerLessonsFunctions(sdk as never, kv as never);
  });

  it("stores the canonical correction edge and excludes obsolete advice from recall", async () => {
    const obsolete = (await sdk.trigger("mem::lesson-save", {
      content:
        "Allocator production recommendation: set MALLOC_ARENA_MAX to 2 on every service.",
      confidence: 0.95,
      project: "runtime",
    })) as { lesson: Lesson };

    const correction = (await sdk.trigger("mem::lesson-save", {
      content:
        "Allocator production recommendation: measure fragmentation before tuning arenas and avoid a global limit.",
      confidence: 0.4,
      project: "runtime",
      corrects: [obsolete.lesson.id],
    })) as { lesson: Lesson };

    const recalled = (await sdk.trigger("mem::lesson-recall", {
      query: "allocator production recommendation",
      project: "runtime",
    })) as { lessons: Lesson[] };

    expect(correction.lesson.corrects).toEqual([obsolete.lesson.id]);
    expect(recalled.lessons.map((lesson) => lesson.id)).toEqual([
      correction.lesson.id,
    ]);
  });

  it("rejects a correction target that does not exist", async () => {
    const result = (await sdk.trigger("mem::lesson-save", {
      content: "Use measured allocator settings",
      project: "runtime",
      corrects: ["lsn_missing"],
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejects correction edges across project scopes", async () => {
    const target = (await sdk.trigger("mem::lesson-save", {
      content: "Use project-local cache keys",
      project: "api",
    })) as { lesson: Lesson };

    const result = (await sdk.trigger("mem::lesson-save", {
      content: "Use shared cache keys",
      project: "worker",
      corrects: [target.lesson.id],
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("same project");
  });

  it("rejects a transitive correction cycle", async () => {
    const lessonB = (await sdk.trigger("mem::lesson-save", {
      content: "Cycle beta strategy validates dependency graphs",
      project: "runtime",
    })) as { lesson: Lesson };

    const lessonA = (await sdk.trigger("mem::lesson-save", {
      content: "Cycle alpha guidance uses immutable tokens",
      project: "runtime",
      corrects: [lessonB.lesson.id],
    })) as { lesson: Lesson };

    const result = (await sdk.trigger("mem::lesson-save", {
      content: "Cycle beta strategy validates dependency graphs",
      project: "runtime",
      corrects: [lessonA.lesson.id],
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("cycle");
  });

  it("excludes superseded lessons from lesson-list", async () => {
    const obsolete = (await sdk.trigger("mem::lesson-save", {
      content: "List obsolete allocator advice",
      confidence: 0.9,
      project: "runtime",
    })) as { lesson: Lesson };

    const correction = (await sdk.trigger("mem::lesson-save", {
      content: "List corrected allocator advice",
      confidence: 0.4,
      project: "runtime",
      corrects: [obsolete.lesson.id],
    })) as { lesson: Lesson };

    const listed = (await sdk.trigger("mem::lesson-list", {
      project: "runtime",
    })) as { lessons: Lesson[] };

    expect(listed.lessons.map((lesson) => lesson.id)).toEqual([
      correction.lesson.id,
    ]);
  });

  it("creates an explicit correction even when its content is a near duplicate", async () => {
    const obsolete = (await sdk.trigger("mem::lesson-save", {
      content:
        "Use bounded exponential retries with jitter for transient network failures",
      project: "api",
    })) as { lesson: Lesson };

    const correction = (await sdk.trigger("mem::lesson-save", {
      content:
        "Use bounded exponential retry with jitter for transient network failure",
      project: "api",
      corrects: [obsolete.lesson.id],
    })) as { success: boolean; action: string; lesson: Lesson };

    expect(correction.success).toBe(true);
    expect(correction.action).toBe("created");
    expect(correction.lesson.id).not.toBe(obsolete.lesson.id);
    expect(correction.lesson.corrects).toEqual([obsolete.lesson.id]);
  });

  it("restores obsolete advice when its only correction is deleted", async () => {
    const obsolete = (await sdk.trigger("mem::lesson-save", {
      content: "Stale state allocator guidance",
      confidence: 0.9,
      project: "runtime",
    })) as { lesson: Lesson };

    const correction = (await sdk.trigger("mem::lesson-save", {
      content: "Stale state corrected guidance",
      confidence: 0.4,
      project: "runtime",
      corrects: [obsolete.lesson.id],
    })) as { lesson: Lesson };
    correction.lesson.deleted = true;
    await kv.set("mem:lessons", correction.lesson.id, correction.lesson);

    const recalled = (await sdk.trigger("mem::lesson-recall", {
      query: "stale state guidance",
      project: "runtime",
    })) as { lessons: Lesson[] };

    expect(recalled.lessons.map((lesson) => lesson.id)).toEqual([
      obsolete.lesson.id,
    ]);
  });

  it("ranks the correction first for at least 29 of 30 labeled pairs", async () => {
    const pairs: Array<{ obsoleteId: string; correctionId: string; query: string }> = [];

    for (let index = 0; index < 30; index++) {
      const label = `${index.toString().padStart(2, "0")}z`;
      const query = `topic${label} legacy${label} setting${label}`;
      const obsolete = (await sdk.trigger("mem::lesson-save", {
        content: `${query} production guidance recommends unsafe${index} default${index} everywhere`,
        confidence: 0.95,
        project: "benchmark",
      })) as { lesson: Lesson };
      const correction = (await sdk.trigger("mem::lesson-save", {
        content: `${query} production guidance requires measured${index} evidence${index} before rollout${index}`,
        confidence: 0.4,
        project: "benchmark",
        corrects: [obsolete.lesson.id],
      })) as { lesson: Lesson };
      pairs.push({
        obsoleteId: obsolete.lesson.id,
        correctionId: correction.lesson.id,
        query,
      });
    }

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

    expect(correctionsFirst / pairs.length).toBeGreaterThanOrEqual(0.95);
  });
});
