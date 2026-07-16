import { describe, expect, it } from "vitest";
import { saveLesson } from "../src/functions/lesson-state.js";
import type { StateKV } from "../src/state/kv.js";
import type { Lesson } from "../src/types.js";
import { KV } from "../src/state/schema.js";

function makeKv(): StateKV {
  const store = new Map<string, Map<string, unknown>>();
  return {
    async get<T>(scope: string, key: string): Promise<T | null> {
      await Promise.resolve();
      const value = store.get(scope)?.get(key);
      return value === undefined ? null : structuredClone(value as T);
    },
    async set<T>(scope: string, key: string, value: T): Promise<T> {
      await Promise.resolve();
      const entries = store.get(scope) ?? new Map<string, unknown>();
      entries.set(key, structuredClone(value));
      store.set(scope, entries);
      return value;
    },
    async list<T>(scope: string): Promise<T[]> {
      await Promise.resolve();
      return structuredClone(Array.from(store.get(scope)?.values() ?? [])) as T[];
    },
  } as StateKV;
}

describe("lesson write serialization", () => {
  it("preserves every concurrent reinforcement", async () => {
    const kv = makeKv();

    await Promise.all(
      Array.from({ length: 20 }, () =>
        saveLesson(kv, {
          content: "Serialize lesson reinforcement updates",
          project: "agentmemory",
        }),
      ),
    );

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].reinforcements).toBe(19);
  });

  it("prevents concurrent correction cycles", async () => {
    const kv = makeKv();
    const first = await saveLesson(kv, { content: "First", project: "p" });
    const second = await saveLesson(kv, { content: "Second", project: "p" });
    if (!first.success || !second.success) throw new Error("seed failed");

    const results = await Promise.all([
      saveLesson(kv, {
        content: "First",
        project: "p",
        corrects: [second.lesson.id],
      }),
      saveLesson(kv, {
        content: "Second",
        project: "p",
        corrects: [first.lesson.id],
      }),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toMatchObject([
      { error: "correction cycle detected" },
    ]);
  });
});
