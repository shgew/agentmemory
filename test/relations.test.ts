import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerRelationsFunction } from "../src/functions/relations.js";
import type { Lesson, Memory } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem_1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "pattern",
    title: "Test memory",
    content: "This is a test memory",
    concepts: ["test"],
    files: [],
    sessionIds: ["ses_1"],
    strength: 5,
    version: 1,
    isLatest: true,
    ...overrides,
  };
}

function makeLesson(overrides: Partial<Lesson>): Lesson {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "lsn_default",
    content: overrides.content ?? "Default lesson",
    context: overrides.context ?? "",
    confidence: overrides.confidence ?? 0.7,
    reinforcements: overrides.reinforcements ?? 0,
    source: overrides.source ?? "manual",
    sourceIds: overrides.sourceIds ?? [],
    project: overrides.project,
    tags: overrides.tags ?? [],
    corrects: overrides.corrects,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    decayRate: overrides.decayRate ?? 0.05,
    deleted: overrides.deleted,
  };
}

describe("Relations Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerRelationsFunction(sdk as never, kv as never);
  });

  describe("mem::relate", () => {
    it("creates a relation between two memories", async () => {
      const mem1 = makeMemory({ id: "mem_1" });
      const mem2 = makeMemory({ id: "mem_2" });
      await kv.set("mem:memories", "mem_1", mem1);
      await kv.set("mem:memories", "mem_2", mem2);

      const result = await sdk.trigger("mem::relate", {
        sourceId: "mem_1",
        targetId: "mem_2",
        type: "related",
      });

      expect((result as { success: boolean }).success).toBe(true);

      const updated1 = await kv.get<Memory>("mem:memories", "mem_1");
      const updated2 = await kv.get<Memory>("mem:memories", "mem_2");
      expect(updated1!.relatedIds).toContain("mem_2");
      expect(updated2!.relatedIds).toContain("mem_1");
    });

    it("returns error when source memory not found", async () => {
      const mem2 = makeMemory({ id: "mem_2" });
      await kv.set("mem:memories", "mem_2", mem2);

      const result = await sdk.trigger("mem::relate", {
        sourceId: "mem_missing",
        targetId: "mem_2",
        type: "related",
      });

      expect((result as { success: boolean }).success).toBe(false);
    });

    it("does not duplicate relatedIds on repeated calls", async () => {
      const mem1 = makeMemory({ id: "mem_1", relatedIds: ["mem_2"] });
      const mem2 = makeMemory({ id: "mem_2", relatedIds: ["mem_1"] });
      await kv.set("mem:memories", "mem_1", mem1);
      await kv.set("mem:memories", "mem_2", mem2);

      await sdk.trigger("mem::relate", {
        sourceId: "mem_1",
        targetId: "mem_2",
        type: "related",
      });

      const updated1 = await kv.get<Memory>("mem:memories", "mem_1");
      expect(updated1!.relatedIds!.filter((id) => id === "mem_2").length).toBe(1);
    });
  });

  describe("mem::evolve", () => {
    it("marks old memory as not latest and creates new version", async () => {
      const original = makeMemory({ id: "mem_old", version: 1 });
      await kv.set("mem:memories", "mem_old", original);

      const result = (await sdk.trigger("mem::evolve", {
        memoryId: "mem_old",
        newContent: "Updated content",
        newTitle: "Updated title",
      })) as { success: boolean; memory: Memory; previousId: string };

      expect(result.success).toBe(true);
      expect(result.memory.version).toBe(2);
      expect(result.memory.content).toBe("Updated content");
      expect(result.memory.title).toBe("Updated title");
      expect(result.memory.parentId).toBe("mem_old");
      expect(result.memory.isLatest).toBe(true);

      const old = await kv.get<Memory>("mem:memories", "mem_old");
      expect(old!.isLatest).toBe(false);
    });

    it("returns error when memory not found", async () => {
      const result = await sdk.trigger("mem::evolve", {
        memoryId: "mem_missing",
        newContent: "Updated content",
      });

      expect((result as { success: boolean }).success).toBe(false);
    });
  });

  describe("mem::get-related", () => {
    it("retrieves related memories within 1 hop", async () => {
      const mem1 = makeMemory({ id: "mem_1", relatedIds: ["mem_2"] });
      const mem2 = makeMemory({ id: "mem_2", relatedIds: ["mem_1", "mem_3"] });
      const mem3 = makeMemory({ id: "mem_3", relatedIds: ["mem_2"] });
      await kv.set("mem:memories", "mem_1", mem1);
      await kv.set("mem:memories", "mem_2", mem2);
      await kv.set("mem:memories", "mem_3", mem3);

      const result = (await sdk.trigger("mem::get-related", {
        memoryId: "mem_1",
        maxHops: 1,
      })) as { results: Array<{ memory: Memory; hop: number }> };

      expect(result.results.length).toBe(1);
      expect(result.results[0].memory.id).toBe("mem_2");
      expect(result.results[0].hop).toBe(1);
    });

    it("retrieves related memories within 2 hops", async () => {
      const mem1 = makeMemory({ id: "mem_1", relatedIds: ["mem_2"] });
      const mem2 = makeMemory({ id: "mem_2", relatedIds: ["mem_1", "mem_3"] });
      const mem3 = makeMemory({ id: "mem_3", relatedIds: ["mem_2"] });
      await kv.set("mem:memories", "mem_1", mem1);
      await kv.set("mem:memories", "mem_2", mem2);
      await kv.set("mem:memories", "mem_3", mem3);

      const result = (await sdk.trigger("mem::get-related", {
        memoryId: "mem_1",
        maxHops: 2,
      })) as { results: Array<{ memory: Memory; hop: number }> };

      expect(result.results.length).toBe(2);
      const ids = result.results.map((r) => r.memory.id);
      expect(ids).toContain("mem_2");
      expect(ids).toContain("mem_3");
    });

    it("traces lesson corrections from obsolete advice to newest correction", async () => {
      await kv.set("mem:lessons", "lsn_v1", makeLesson({ id: "lsn_v1", project: "api" }));
      await kv.set(
        "mem:lessons",
        "lsn_v2",
        makeLesson({ id: "lsn_v2", project: "api", corrects: ["lsn_v1"] }),
      );
      await kv.set(
        "mem:lessons",
        "lsn_v3",
        makeLesson({ id: "lsn_v3", project: "api", corrects: ["lsn_v2"] }),
      );

      const result = (await sdk.trigger("mem::get-related", {
        memoryId: "lsn_v1",
        maxHops: 2,
      })) as {
        results: Array<{
          lesson: Lesson;
          hop: number;
          direction: string;
        }>;
      };

      expect(result.results.map(({ lesson, hop, direction }) => ({
        id: lesson.id,
        hop,
        direction,
      }))).toEqual([
        { id: "lsn_v2", hop: 1, direction: "correctedBy" },
        { id: "lsn_v3", hop: 2, direction: "correctedBy" },
      ]);
    });

    it("traces a correcting lesson back to obsolete advice", async () => {
      await kv.set("mem:lessons", "lsn_v1", makeLesson({ id: "lsn_v1", project: "api" }));
      await kv.set(
        "mem:lessons",
        "lsn_v2",
        makeLesson({ id: "lsn_v2", project: "api", corrects: ["lsn_v1"] }),
      );

      const result = (await sdk.trigger("mem::get-related", {
        memoryId: "lsn_v2",
        maxHops: 1,
      })) as {
        results: Array<{ lesson: Lesson; direction: string }>;
      };

      expect(result.results).toEqual([
        expect.objectContaining({
          lesson: expect.objectContaining({ id: "lsn_v1" }),
          direction: "corrects",
        }),
      ]);
    });
  });
});
