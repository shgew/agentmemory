import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getSearchIndex,
  getVectorIndex,
  isIndexRebuildPending,
  rebuildIndex,
  registerSearchFunction,
  setEmbeddingProvider,
  setVectorIndex,
  vectorIndexAddGuarded,
  vectorIndexRemove,
} from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";

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
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

describe("mem::search", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);

    const session: Session = {
      id: "ses_1",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
    };
    await kv.set(KV.sessions, session.id, session);

    const obsA: CompressedObservation = {
      id: "obs_a",
      sessionId: "ses_1",
      timestamp: "2026-01-01T00:00:00Z",
      type: "decision",
      title: "Auth middleware decision",
      subtitle: "JWT strategy",
      facts: ["Use rotating refresh tokens"],
      narrative: "Implemented auth middleware with JWT refresh rotation.",
      concepts: ["auth", "jwt"],
      files: ["src/auth.ts"],
      importance: 8,
    };
    const obsB: CompressedObservation = {
      id: "obs_b",
      sessionId: "ses_1",
      timestamp: "2026-01-02T00:00:00Z",
      type: "file_edit",
      title: "UI button styling",
      facts: ["Updated primary button color"],
      narrative: "Adjusted button styles in the settings page.",
      concepts: ["ui", "css"],
      files: ["src/ui/button.tsx"],
      importance: 4,
    };

    await kv.set(KV.observations("ses_1"), obsA.id, obsA);
    await kv.set(KV.observations("ses_1"), obsB.id, obsB);

    getSearchIndex().clear();
    getSearchIndex().add(obsA);
    getSearchIndex().add(obsB);
  });

  it("returns full format by default", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth middleware",
    })) as { format: string; results: Array<{ observation: CompressedObservation }> };

    expect(result.format).toBe("full");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.observation.id).toBe("obs_a");
  });

  it("returns compact format when requested", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth",
      format: "compact",
    })) as { format: string; results: Array<{ obsId: string; title: string }> };

    expect(result.format).toBe("compact");
    expect(result.results[0]?.obsId).toBe("obs_a");
    expect(result.results[0]?.title).toBe("Auth middleware decision");
  });

  it("returns narrative text and respects token budget", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth ui",
      format: "narrative",
      token_budget: 20,
    })) as {
      format: string;
      results: Array<{ obsId: string }>;
      text: string;
      tokens_used: number;
      tokens_budget: number;
      truncated: boolean;
    };

    expect(result.format).toBe("narrative");
    expect(result.tokens_budget).toBe(20);
    expect(result.tokens_used).toBeLessThanOrEqual(20);
    expect(typeof result.text).toBe("string");
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects invalid format values", async () => {
    await expect(
      sdk.trigger("mem::search", { query: "auth", format: "verbose" }),
    ).rejects.toThrow("format must be one of");
  });

  it("surfaces saved memories from KV.memories (#265)", async () => {
    // mem::remember persists to KV.memories under a synthetic sessionId
    // ("memory") that has no corresponding KV.observations entry. mem::search
    // must fall back to KV.memories or memory_recall returns empty.
    await kv.set(KV.memories, "mem_x1", {
      id: "mem_x1",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "fact",
      title: "Pineapple belongs on pizza",
      content: "Pineapple belongs on pizza for testing fallback path.",
      concepts: ["pineapple", "pizza"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    });
    // Force the rebuild to pick up the new memory (mem::search only
    // rebuilds on first call when idx.size === 0).
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "pineapple pizza",
      format: "compact",
    })) as { results: Array<{ obsId: string; title: string }> };

    const hit = result.results.find((r) => r.obsId === "mem_x1");
    expect(hit).toBeDefined();
    expect(hit?.title).toBe("Pineapple belongs on pizza");
  });

  it("rebuildIndex populates the vector index", async () => {
    const mockEmbedder = {
      name: "test",
      dimensions: 3,
      embed: async (_text: string) => new Float32Array([0.1, 0.2, 0.3]),
      embedBatch: async (_texts: string[]) =>
        _texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    };
    setEmbeddingProvider(mockEmbedder);
    setVectorIndex(new VectorIndex());

    await rebuildIndex(kv as never);

    const vi = getVectorIndex();
    expect(vi).not.toBeNull();
    expect(vi!.size).toBeGreaterThan(0);

    // Cleanup
    setVectorIndex(null);
    setEmbeddingProvider(null);
  });

  it("keeps live indexes available and replays mutations during rebuild", async () => {
    const liveOnly: CompressedObservation = {
      id: "obs_live",
      sessionId: "ses_1",
      timestamp: "2026-01-03T00:00:00Z",
      sourceType: "test",
      type: "decision",
      title: "Live sentinel",
      facts: [],
      narrative: "Existing live index entry",
      concepts: [],
      files: [],
      importance: 5,
    };
    const late: CompressedObservation = {
      id: "obs_late",
      sessionId: "ses_1",
      timestamp: "2026-01-04T00:00:00Z",
      sourceType: "test",
      type: "decision",
      title: "Concurrent addition",
      facts: [],
      narrative: "Added while rebuild waits",
      concepts: [],
      files: [],
      importance: 5,
    };
    getSearchIndex().add(liveOnly);

    const vectors = new VectorIndex();
    vectors.add("obs_live", "ses_1", new Float32Array([1, 0, 0]));
    setVectorIndex(vectors);

    let batchStarted: (() => void) | undefined;
    let releaseBatch: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      batchStarted = resolve;
    });
    setEmbeddingProvider({
      name: "blocked",
      dimensions: 3,
      embed: async () => new Float32Array([0, 1, 0]),
      embedBatch: async (texts) => {
        batchStarted?.();
        await new Promise<void>((resolve) => {
          releaseBatch = resolve;
        });
        return texts.map(() => new Float32Array([0, 1, 0]));
      },
    });

    const rebuilding = rebuildIndex(kv as never);
    await started;
    const bm25StayedLive = getSearchIndex().search("live sentinel").length === 1;
    const vectorsStayedLive = getVectorIndex()!.serialize().includes('"obs_live"');

    getSearchIndex().remove("obs_a");
    getSearchIndex().add(late);
    vectorIndexRemove("obs_a");
    await vectorIndexAddGuarded("obs_late", "ses_1", late.narrative, {
      kind: "observation",
      logId: late.id,
    });
    releaseBatch?.();
    await rebuilding;

    expect(bm25StayedLive).toBe(true);
    expect(vectorsStayedLive).toBe(true);
    expect(getSearchIndex().has("obs_a")).toBe(false);
    expect(getSearchIndex().has("obs_b")).toBe(true);
    expect(getSearchIndex().has("obs_late")).toBe(true);
    expect(getVectorIndex()!.serialize()).not.toContain('"obs_a"');
    expect(getVectorIndex()!.serialize()).toContain('"obs_b"');
    expect(getVectorIndex()!.serialize()).toContain('"obs_late"');

    setVectorIndex(null);
    setEmbeddingProvider(null);
  });

  it("queues concurrent rebuilds", async () => {
    let firstListStarted: (() => void) | undefined;
    let releaseFirstList: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstListStarted = resolve;
    });
    let memoryListCalls = 0;
    const blockedKv = {
      ...kv,
      list: async <T>(scope: string): Promise<T[]> => {
        if (scope === KV.memories) {
          memoryListCalls++;
          if (memoryListCalls === 1) {
            firstListStarted?.();
            await new Promise<void>((resolve) => {
              releaseFirstList = resolve;
            });
          }
        }
        return kv.list<T>(scope);
      },
    };

    const first = rebuildIndex(blockedKv as never);
    await started;
    const second = rebuildIndex(blockedKv as never);

    expect(isIndexRebuildPending()).toBe(true);
    expect(memoryListCalls).toBe(1);

    releaseFirstList?.();
    await expect(Promise.all([first, second])).resolves.toEqual([2, 2]);
    expect(memoryListCalls).toBe(2);
    expect(isIndexRebuildPending()).toBe(false);
  });

  it("serves live entries without waiting for a pending rebuild", async () => {
    let listStarted: (() => void) | undefined;
    let releaseList: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      listStarted = resolve;
    });
    const blockedKv = {
      ...kv,
      list: async <T>(scope: string): Promise<T[]> => {
        if (scope === KV.memories) {
          listStarted?.();
          await new Promise<void>((resolve) => {
            releaseList = resolve;
          });
        }
        return kv.list<T>(scope);
      },
    };
    const pendingSdk = mockSdk();
    registerSearchFunction(pendingSdk as never, blockedKv as never);
    getSearchIndex().clear();

    const rebuilding = rebuildIndex(blockedKv as never);
    await started;
    const emptyResult = (await pendingSdk.trigger("mem::search", {
      query: "absent during rebuild",
      format: "compact",
    })) as { results: Array<{ obsId: string }> };
    expect(emptyResult.results).toEqual([]);

    const live: CompressedObservation = {
      id: "obs_live_pending",
      sessionId: "ses_1",
      timestamp: "2026-01-03T00:00:00Z",
      type: "decision",
      title: "Pending rebuild sentinel",
      facts: [],
      narrative: "Search stays available during rebuild",
      concepts: [],
      files: [],
      importance: 5,
    };
    await kv.set(KV.observations("ses_1"), live.id, live);
    getSearchIndex().add(live);

    const result = (await pendingSdk.trigger("mem::search", {
      query: "pending rebuild sentinel",
      format: "compact",
    })) as { results: Array<{ obsId: string }> };

    expect(result.results.map((entry) => entry.obsId)).toContain(live.id);

    releaseList?.();
    await rebuilding;
    expect(isIndexRebuildPending()).toBe(false);
  });

  it("does not wait for a cold rebuild", async () => {
    let releaseList = () => {};
    const listBlocked = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let markListStarted = () => {};
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const blockedKv = {
      ...kv,
      list: async <T>(scope: string): Promise<T[]> => {
        if (scope === KV.memories) {
          markListStarted();
          await listBlocked;
        }
        return kv.list<T>(scope);
      },
    };
    const coldSdk = mockSdk();
    registerSearchFunction(coldSdk as never, blockedKv as never);
    getSearchIndex().clear();
    let searchResolved = false;
    const searching = coldSdk
      .trigger("mem::search", { query: "cold", format: "compact" })
      .then((result) => {
        searchResolved = true;
        return result;
      });
    await listStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      expect(searchResolved).toBe(true);
    } finally {
      releaseList();
    }

    await expect(searching).resolves.toMatchObject({ results: [] });
    await vi.waitFor(() => expect(isIndexRebuildPending()).toBe(false));
  });

  it("leaves live indexes untouched when strict rebuild fails", async () => {
    const liveOnly: CompressedObservation = {
      id: "obs_live",
      sessionId: "ses_1",
      timestamp: "2026-01-03T00:00:00Z",
      sourceType: "test",
      type: "decision",
      title: "Live sentinel",
      facts: [],
      narrative: "Existing live index entry",
      concepts: [],
      files: [],
      importance: 5,
    };
    getSearchIndex().add(liveOnly);
    const vectors = new VectorIndex();
    vectors.add("obs_live", "ses_1", new Float32Array([1, 0, 0]));
    setVectorIndex(vectors);
    setEmbeddingProvider({
      name: "test",
      dimensions: 3,
      embed: async () => new Float32Array([0, 1, 0]),
      embedBatch: async (texts) =>
        texts.map(() => new Float32Array([0, 1, 0])),
    });
    const failingKv = {
      ...kv,
      list: async <T>(scope: string): Promise<T[]> => {
        if (scope === KV.sessions) throw new Error("session read failed");
        return kv.list<T>(scope);
      },
    };

    await expect(
      rebuildIndex(failingKv as never, { strict: true }),
    ).rejects.toThrow("session read failed");

    expect(getSearchIndex().search("live sentinel")).toHaveLength(1);
    expect(getVectorIndex()!.serialize()).toContain('"obs_live"');

    setVectorIndex(null);
    setEmbeddingProvider(null);
  });
});
