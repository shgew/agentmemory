import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { fingerprintId, KV } from "../src/state/schema.js";
import type { Lesson } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function makeLegacyLesson(content: string, project?: string): Lesson {
  const now = new Date().toISOString();
  return {
    id: fingerprintId("lsn", content.trim().toLowerCase()),
    content,
    context: "",
    confidence: 0.5,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    project,
    tags: [],
    createdAt: now,
    updatedAt: now,
    decayRate: 0.05,
  };
}

describe("Lesson duplicate filtering", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerLessonsFunctions(sdk as never, kv as never);
  });

  it("creates distinct identities for identical content in different projects", async () => {
    const first = (await sdk.trigger("mem::lesson-save", {
      content: "Use bounded retries for transient network failures",
      project: "api",
    })) as { action: string; lesson: Lesson };

    const second = (await sdk.trigger("mem::lesson-save", {
      content: "Use bounded retries for transient network failures",
      project: "worker",
    })) as { action: string; lesson: Lesson };

    expect(second.action).toBe("created");
    expect(second.lesson.id).not.toBe(first.lesson.id);
    expect(second.lesson.project).toBe("worker");
    expect(await kv.list<Lesson>(KV.lessons)).toHaveLength(2);
  });

  it("reports an exact same-project reinforcement distinctly from creation", async () => {
    const first = (await sdk.trigger("mem::lesson-save", {
      content: "Prefer immutable request models",
      project: "api",
    })) as { lesson: Lesson };

    const second = (await sdk.trigger("mem::lesson-save", {
      content: "Prefer immutable request models",
      project: "api",
    })) as { action: string; match: string; lesson: Lesson };

    expect(second.action).toBe("strengthened");
    expect(second.match).toBe("exact");
    expect(second.lesson.id).toBe(first.lesson.id);
  });

  it("reinforces a same-project legacy content-only identity in place", async () => {
    const legacy = makeLegacyLesson("Keep cache keys stable", "api");
    await kv.set(KV.lessons, legacy.id, legacy);

    const result = (await sdk.trigger("mem::lesson-save", {
      content: legacy.content,
      project: "api",
    })) as { action: string; match: string; lesson: Lesson };

    expect(result.action).toBe("strengthened");
    expect(result.match).toBe("legacy-exact");
    expect(result.lesson.id).toBe(legacy.id);
    expect(result.lesson.reinforcements).toBe(1);
  });

  it("does not reinforce a legacy identity from a different project", async () => {
    const legacy = makeLegacyLesson("Keep cache keys stable", "api");
    await kv.set(KV.lessons, legacy.id, legacy);

    const result = (await sdk.trigger("mem::lesson-save", {
      content: legacy.content,
      project: "worker",
    })) as { action: string; lesson: Lesson };

    expect(result.action).toBe("created");
    expect(result.lesson.id).not.toBe(legacy.id);
    expect(result.lesson.project).toBe("worker");
    expect(legacy.reinforcements).toBe(0);
  });

  it("reinforces a same-project near duplicate and labels the match", async () => {
    const first = (await sdk.trigger("mem::lesson-save", {
      content:
        "Use bounded exponential retries with jitter for transient network failures",
      project: "api",
    })) as { lesson: Lesson };

    const second = (await sdk.trigger("mem::lesson-save", {
      content:
        "Use bounded exponential retry with jitter for transient network failure",
      project: "api",
    })) as {
      action: string;
      match: string;
      similarity: number;
      lesson: Lesson;
    };

    expect(second.action).toBe("strengthened");
    expect(second.match).toBe("near-duplicate");
    expect(second.similarity).toBeGreaterThanOrEqual(0.7);
    expect(second.lesson.id).toBe(first.lesson.id);
    expect(await kv.list<Lesson>(KV.lessons)).toHaveLength(1);
  });

  it("does not merge near duplicates across projects", async () => {
    const first = (await sdk.trigger("mem::lesson-save", {
      content:
        "Use bounded exponential retries with jitter for transient network failures",
      project: "api",
    })) as { lesson: Lesson };

    const second = (await sdk.trigger("mem::lesson-save", {
      content:
        "Use bounded exponential retry with jitter for transient network failure",
      project: "worker",
    })) as { action: string; lesson: Lesson };

    expect(second.action).toBe("created");
    expect(second.lesson.id).not.toBe(first.lesson.id);
    expect(await kv.list<Lesson>(KV.lessons)).toHaveLength(2);
  });

  it("treats scoped and unscoped lessons as different project scopes", async () => {
    const unscoped = (await sdk.trigger("mem::lesson-save", {
      content: "Use bounded retries for transient network failures",
    })) as { lesson: Lesson };

    const scoped = (await sdk.trigger("mem::lesson-save", {
      content: "Use bounded retries for transient network failures",
      project: "api",
    })) as { action: string; lesson: Lesson };

    expect(scoped.action).toBe("created");
    expect(scoped.lesson.id).not.toBe(unscoped.lesson.id);
  });
});
