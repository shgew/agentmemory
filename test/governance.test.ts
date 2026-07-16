import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const decrementImageRef = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../src/functions/image-refs.js", () => ({
  decrementImageRef,
}));

import { registerGovernanceFunction } from "../src/functions/governance.js";
import {
  getSearchIndex,
  setIndexPersistence,
} from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
import type { Memory, AuditEntry, Session } from "../src/types.js";

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
    update: async <T>(
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ): Promise<T> => {
      const existing =
        (store.get(scope)?.get(key) as Record<string, unknown>) ?? {};
      const next = { ...existing };
      for (const op of ops) {
        if (op.type === "set") next[op.path] = op.value;
      }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, next);
      return next as T;
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
  };
}

function makeMemory(id: string, type: Memory["type"] = "pattern"): Memory {
  return {
    id,
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    type,
    title: `Memory ${id}`,
    content: `Content for ${id}`,
    concepts: ["test"],
    files: [],
    sessionIds: ["ses_1"],
    strength: 5,
    version: 1,
    isLatest: true,
  };
}

function makeSession(observationCount: number): Session {
  return {
    id: "ses_1",
    project: "agentmemory",
    cwd: "/repo",
    startedAt: "2026-02-01T00:00:00Z",
    status: "active",
    observationCount,
  };
}

describe("Governance Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    decrementImageRef.mockReset();
    decrementImageRef.mockResolvedValue(undefined);
    sdk = mockSdk();
    kv = mockKV();
    registerGovernanceFunction(sdk as never, kv as never);

    await kv.set("mem:memories", "mem_1", makeMemory("mem_1", "pattern"));
    await kv.set("mem:memories", "mem_2", makeMemory("mem_2", "bug"));
    await kv.set("mem:memories", "mem_3", makeMemory("mem_3", "pattern"));
  });

  it("governance-delete removes specified memories", async () => {
    const result = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["mem_1"],
      reason: "outdated",
    })) as { success: boolean; deleted: number; total: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(result.total).toBe(1);

    const remaining = await kv.list("mem:memories");
    expect(remaining.length).toBe(2);
  });

  it("governance-delete handles non-existent IDs gracefully", async () => {
    const result = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["nonexistent_1", "nonexistent_2"],
    })) as { success: boolean; deleted: number; total: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.total).toBe(2);

    const remaining = await kv.list("mem:memories");
    expect(remaining.length).toBe(3);
  });

  it("governance-delete preserves a memory when image cleanup fails", async () => {
    const imageRef = "/managed/memory.png";
    await kv.set(KV.memories, "mem_1", {
      ...makeMemory("mem_1"),
      imageRef,
    });
    await kv.set(KV.accessLog, "mem_1", { memoryId: "mem_1" });
    decrementImageRef.mockRejectedValueOnce(new Error("image cleanup failed"));

    await expect(
      sdk.trigger("mem::governance-delete", { memoryIds: ["mem_1"] }),
    ).rejects.toThrow("image cleanup failed");

    expect(await kv.get(KV.memories, "mem_1")).not.toBeNull();
    expect(await kv.get(KV.accessLog, "mem_1")).not.toBeNull();

    const result = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["mem_1"],
    })) as { success: boolean; deleted: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(decrementImageRef).toHaveBeenCalledTimes(2);
    expect(await kv.get(KV.memories, "mem_1")).toBeNull();
    expect(await kv.get(KV.accessLog, "mem_1")).toBeNull();
  });

  it("governance-delete removes an observation and its retained raw payload", async () => {
    await kv.set(KV.sessions, "ses_1", makeSession(1));
    await kv.set(KV.observations("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      title: "Edit auth",
    });
    await kv.set(KV.rawPayloads, "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      hookType: "post_tool_use",
      raw: {},
    });
    await kv.set(KV.accessLog, "obs_1", { memoryId: "obs_1" });

    const result = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["obs_1"],
      reason: "remove captured payload",
    })) as { success: boolean; deleted: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(await kv.get(KV.observations("ses_1"), "obs_1")).toBeNull();
    expect(await kv.get(KV.rawPayloads, "obs_1")).toBeNull();
    expect(await kv.get(KV.accessLog, "obs_1")).toBeNull();
    expect((await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount).toBe(
      0,
    );
  });

  it("governance-delete finds compressed observations without raw payloads", async () => {
    await kv.set(KV.sessions, "ses_1", makeSession(2));
    await kv.set(KV.observations("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      title: "Edit auth",
    });
    await kv.set(KV.observations("ses_1"), "obs_2", {
      id: "obs_2",
      sessionId: "ses_1",
      title: "Run tests",
    });
    await kv.set(KV.accessLog, "obs_1", { memoryId: "obs_1" });

    const result = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["obs_1"],
    })) as { success: boolean; deleted: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(await kv.get(KV.observations("ses_1"), "obs_1")).toBeNull();
    expect(await kv.get(KV.observations("ses_1"), "obs_2")).not.toBeNull();
    expect(await kv.get(KV.accessLog, "obs_1")).toBeNull();
    expect((await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount).toBe(
      1,
    );
  });

  it("governance-delete preserves an observation when image cleanup fails", async () => {
    const imageRef = "/managed/image.png";
    await kv.set(KV.sessions, "ses_1", makeSession(1));
    await kv.set(KV.observations("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      title: "Capture image",
      imageRef,
    });
    await kv.set(KV.rawPayloads, "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      hookType: "post_tool_use",
      raw: {},
      imageData: imageRef,
    });
    await kv.set(KV.accessLog, "obs_1", { memoryId: "obs_1" });
    decrementImageRef.mockRejectedValueOnce(new Error("image cleanup failed"));

    await expect(
      sdk.trigger("mem::governance-delete", { memoryIds: ["obs_1"] }),
    ).rejects.toThrow("image cleanup failed");

    expect(await kv.get(KV.observations("ses_1"), "obs_1")).not.toBeNull();
    expect(await kv.get(KV.rawPayloads, "obs_1")).not.toBeNull();
    expect(await kv.get(KV.accessLog, "obs_1")).not.toBeNull();
    expect((await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount).toBe(
      1,
    );

    const result = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["obs_1"],
    })) as { success: boolean; deleted: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(decrementImageRef).toHaveBeenCalledTimes(2);
    expect(await kv.get(KV.observations("ses_1"), "obs_1")).toBeNull();
    expect(await kv.get(KV.rawPayloads, "obs_1")).toBeNull();
    expect(await kv.get(KV.accessLog, "obs_1")).toBeNull();
    expect((await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount).toBe(
      0,
    );
  });

  it("governance-bulk deletes by type filter", async () => {
    const result = (await sdk.trigger("mem::governance-bulk", {
      type: ["pattern"],
    })) as { success: boolean; deleted: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(2);

    const remaining = await kv.list<Memory>("mem:memories");
    expect(remaining.length).toBe(1);
    expect(remaining[0].type).toBe("bug");
  });

  it("governance-bulk respects dryRun", async () => {
    const result = (await sdk.trigger("mem::governance-bulk", {
      type: ["pattern"],
      dryRun: true,
    })) as { success: boolean; dryRun: boolean; wouldDelete: number; ids: string[] };

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.wouldDelete).toBe(2);
    expect(result.ids).toContain("mem_1");
    expect(result.ids).toContain("mem_3");

    const remaining = await kv.list("mem:memories");
    expect(remaining.length).toBe(3);
  });

  // Delete paths must tear down the BM25 index entry and trigger an
  // IndexPersistence save so a hard process exit can't restore a stale
  // snapshot at next boot.
  describe("search index cleanup on delete", () => {
    function indexedObs(id: string, title: string) {
      return memoryToObservation({
        id,
        createdAt: "2026-02-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        type: "fact",
        title,
        content: title,
        concepts: [],
        files: [],
        sessionIds: ["ses_1"],
        strength: 5,
        version: 1,
        isLatest: true,
      });
    }

    function mockPersistence() {
      return {
        scheduleSave: vi.fn(),
        save: vi.fn(async () => {}),
      };
    }

    beforeEach(() => {
      // SearchIndex is a module-level singleton — wipe it so cases
      // don't bleed into each other.
      getSearchIndex().clear();
      setIndexPersistence(null);
    });

    // The persistence singleton is module-scoped; without this reset
    // the last test's mock would leak into sibling tests in the outer
    // suite and trigger unexpected spy invocations.
    afterEach(() => {
      setIndexPersistence(null);
    });

    it("governance-delete removes the memory from the search index", async () => {
      getSearchIndex().add(indexedObs("mem_1", "alpha"));
      getSearchIndex().add(indexedObs("mem_2", "beta"));
      expect(getSearchIndex().has("mem_1")).toBe(true);

      await sdk.trigger("mem::governance-delete", {
        memoryIds: ["mem_1"],
      });

      expect(getSearchIndex().has("mem_1")).toBe(false);
      expect(getSearchIndex().has("mem_2")).toBe(true);
    });

    it("governance-delete flushes persistence immediately", async () => {
      const persistence = mockPersistence();
      setIndexPersistence(persistence);
      getSearchIndex().add(indexedObs("mem_1", "alpha"));

      await sdk.trigger("mem::governance-delete", { memoryIds: ["mem_1"] });

      // Delete paths must use the synchronous save (not the debounced
      // scheduleSave) so a process exit immediately after delete can't
      // resurrect the entry on next boot.
      expect(persistence.save).toHaveBeenCalled();
    });

    it("governance-delete skips persistence flush when nothing was deleted", async () => {
      const persistence = mockPersistence();
      setIndexPersistence(persistence);

      await sdk.trigger("mem::governance-delete", {
        memoryIds: ["nonexistent_999"],
      });

      expect(persistence.save).not.toHaveBeenCalled();
    });

    it("governance-bulk removes deleted memories from the search index", async () => {
      getSearchIndex().add(indexedObs("mem_1", "alpha"));
      getSearchIndex().add(indexedObs("mem_2", "beta"));
      getSearchIndex().add(indexedObs("mem_3", "gamma"));

      await sdk.trigger("mem::governance-bulk", { type: ["pattern"] });

      // mem_1 and mem_3 are type "pattern" per the outer beforeEach.
      expect(getSearchIndex().has("mem_1")).toBe(false);
      expect(getSearchIndex().has("mem_3")).toBe(false);
      expect(getSearchIndex().has("mem_2")).toBe(true);
    });

    it("governance-bulk flushes persistence immediately", async () => {
      const persistence = mockPersistence();
      setIndexPersistence(persistence);
      getSearchIndex().add(indexedObs("mem_1", "alpha"));

      await sdk.trigger("mem::governance-bulk", { type: ["pattern"] });

      expect(persistence.save).toHaveBeenCalled();
    });
  });

  it("audit-query returns audit entries", async () => {
    await sdk.trigger("mem::governance-delete", {
      memoryIds: ["mem_1"],
      reason: "cleanup",
    });

    const entries = (await sdk.trigger("mem::audit-query", {})) as AuditEntry[];

    expect(entries.length).toBe(1);
    expect(entries[0].operation).toBe("delete");
    expect(entries[0].functionId).toBe("mem::governance-delete");
  });
});
