import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { VectorIndex } from "../src/state/vector-index.js";
import {
  reindexVectors,
  setVectorIndex,
  setEmbeddingProvider,
  getVectorIndex,
} from "../src/functions/search.js";
import type { EmbeddingProvider } from "../src/types.js";

const fourDimProvider: EmbeddingProvider = {
  name: "test-4d",
  dimensions: 4,
  embed: async (_text: string) => new Float32Array([0.1, 0.2, 0.3, 0.4]),
  embedBatch: async (texts: string[]) =>
    texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4])),
};

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (_scope: string, _key: string): Promise<void> => {},
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

async function seedCorpus(kv: ReturnType<typeof mockKV>) {
  await kv.set("mem:sessions", "ses_1", { id: "ses_1" });
  await kv.set("mem:obs:ses_1", "obs_1", {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "decision",
    title: "reindex observation",
    facts: ["x"],
    narrative: "to be re-embedded",
    concepts: [],
    files: [],
    importance: 5,
  });
  await kv.set("mem:memories", "mem_1", {
    id: "mem_1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "fact",
    title: "reindex memory",
    content: "this memory will be re-embedded",
    concepts: [],
    files: [],
    sessionIds: ["ses_1"],
    strength: 7,
    version: 1,
    isLatest: true,
  });
}

describe("reindexVectors", () => {
  beforeEach(() => {
    setVectorIndex(null);
    setEmbeddingProvider(null);
  });

  it("re-embeds the corpus and swaps it into the live vector index", async () => {
    const kv = mockKV();
    await seedCorpus(kv);
    const live = new VectorIndex();
    setVectorIndex(live);
    setEmbeddingProvider(fourDimProvider);

    const result = await reindexVectors(kv as never);

    expect(result.success).toBe(true);
    expect(result.swapped).toBe(true);
    expect(result.failed).toBe(0);
    expect(result.totalProcessed).toBe(2);
    expect(result.vectorSize).toBe(2);
    expect(result.provider).toBe("test-4d");
    expect(result.dimensions).toBe(4);
    expect(getVectorIndex()!.size).toBe(2);
  });

  it("returns success:false without swapping when no embedding provider is configured", async () => {
    const kv = mockKV();
    await seedCorpus(kv);
    const live = new VectorIndex();
    setVectorIndex(live);
    setEmbeddingProvider(null);

    const result = await reindexVectors(kv as never);

    expect(result.success).toBe(false);
    expect(result.swapped).toBe(false);
    expect(result.error).toBeTruthy();
    expect(getVectorIndex()!.size).toBe(0);
  });

  it("returns success:false without throwing when the vector index is not initialized", async () => {
    const kv = mockKV();
    await seedCorpus(kv);
    setVectorIndex(null);
    setEmbeddingProvider(fourDimProvider);

    const result = await reindexVectors(kv as never);

    expect(result.success).toBe(false);
    expect(result.swapped).toBe(false);
  });
});
