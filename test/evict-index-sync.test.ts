import { describe, expect, it, vi } from "vitest";
import type { CompressedObservation, Memory, Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/search.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/search.js")>();
  const remove = vi.fn();
  return {
    ...actual,
    getSearchIndex: vi.fn(() => ({ remove })),
    vectorIndexRemove: vi.fn(),
    flushIndexSave: vi.fn(async () => {}),
  };
});

import { registerEvictFunction } from "../src/functions/evict.js";
import {
  getSearchIndex,
  vectorIndexRemove,
  flushIndexSave,
} from "../src/functions/search.js";

type Store = Map<string, Map<string, unknown>>;
type Handler = (payload: unknown) => unknown | Promise<unknown>;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function mockKV(store: Store) {
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
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
  const handlers = new Map<string, Handler>();
  return {
    sdk: {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      registerTrigger: vi.fn(),
      trigger: async (input: { function_id: string; payload: unknown }) => {
        const handler = handlers.get(input.function_id);
        if (!handler) throw new Error(`missing handler: ${input.function_id}`);
        return handler(input.payload);
      },
    },
  };
}

function removeMock() {
  return (getSearchIndex() as { remove: ReturnType<typeof vi.fn> }).remove;
}

describe("mem::evict keeps the search index in sync", () => {
  it("removes evicted low-importance observations from the index and flushes", async () => {
    const sessionId = "ses_idx";
    const session: Session = {
      id: sessionId,
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      startedAt: daysAgo(1),
      status: "active",
      observationCount: 1,
    };
    const obs: CompressedObservation = {
      id: "obs_old",
      sessionId,
      timestamp: daysAgo(120),
      type: "file_read",
      title: "stale read",
      facts: [],
      narrative: "old low value read",
      concepts: [],
      files: ["src/x.ts"],
      importance: 1,
    };
    const store: Store = new Map([
      [KV.sessions, new Map<string, unknown>([[session.id, session]])],
      [KV.summaries, new Map()],
      [KV.observations(sessionId), new Map<string, unknown>([[obs.id, obs]])],
      [KV.config, new Map()],
      [KV.audit, new Map()],
      [KV.memories, new Map()],
    ]);
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { lowImportanceObs: number };

    expect(result.lowImportanceObs).toBe(1);
    expect(await kv.get(KV.observations(sessionId), "obs_old")).toBeNull();
    expect(removeMock()).toHaveBeenCalledWith("obs_old");
    expect(vi.mocked(vectorIndexRemove)).toHaveBeenCalledWith("obs_old");
    expect(vi.mocked(flushIndexSave)).toHaveBeenCalled();
  });

  it("removes evicted expired memories from the index and flushes", async () => {
    const mem: Memory = {
      id: "mem_expired",
      createdAt: daysAgo(10),
      updatedAt: daysAgo(10),
      type: "fact",
      title: "expired fact",
      content: "old fact",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 1,
      version: 1,
      isLatest: true,
      forgetAfter: daysAgo(1),
    };
    const store: Store = new Map([
      [KV.sessions, new Map()],
      [KV.summaries, new Map()],
      [KV.config, new Map()],
      [KV.audit, new Map()],
      [KV.memories, new Map<string, unknown>([[mem.id, mem]])],
    ]);
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { expiredMemories: number };

    expect(result.expiredMemories).toBe(1);
    expect(await kv.get(KV.memories, "mem_expired")).toBeNull();
    expect(removeMock()).toHaveBeenCalledWith("mem_expired");
    expect(vi.mocked(vectorIndexRemove)).toHaveBeenCalledWith("mem_expired");
    expect(vi.mocked(flushIndexSave)).toHaveBeenCalled();
  });
});
