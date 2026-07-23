import { beforeEach, describe, expect, it, vi } from "vitest";

const searchAdd = vi.hoisted(() => vi.fn());
const searchIds = vi.hoisted(() => new Set<string>());
const vectorAdd = vi.hoisted(() => vi.fn().mockResolvedValue(false));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({
    add: (observation: { id: string }) => {
      searchAdd(observation);
      searchIds.add(observation.id);
    },
    has: (id: string) => searchIds.has(id),
  }),
  vectorIndexAddGuarded: vectorAdd,
}));

import { drainPendingCompression } from "../src/functions/pending-compression.js";
import {
  deleteRawObservation,
  storeRawObservation,
} from "../src/functions/raw-observations.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  PendingCompressionEntry,
  RawObservation,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const kv = {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
  return kv;
}

function rawObservation(id = "obs_pending"): RawObservation {
  return {
    id,
    sessionId: "ses_pending",
    timestamp: "2026-07-16T10:00:00.000Z",
    hookType: "prompt_submit",
    raw: { prompt: "retain this" },
    userPrompt: "retain this",
  };
}

async function seedPending(
  kv: ReturnType<typeof mockKV>,
  raw: RawObservation,
): Promise<void> {
  const entry: PendingCompressionEntry = {
    id: raw.id,
    sessionId: raw.sessionId,
  };
  await kv.set(KV.rawPayloads, raw.id, raw);
  await kv.set(KV.pendingCompression(raw.sessionId), raw.id, entry);
}

describe("pending compression recovery", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
    searchAdd.mockReset();
    searchIds.clear();
    vectorAdd.mockClear();
  });

  it("rebuilds synthetic observations without invoking mem::compress", async () => {
    const kv = mockKV();
    const raw = rawObservation();
    await seedPending(kv, raw);
    const trigger = vi.fn(async () => {
      throw new Error("LLM compression must remain disabled");
    });
    const list = vi.spyOn(kv, "list");

    const result = await drainPendingCompression(
      { trigger } as never,
      kv as never,
      raw.sessionId,
    );

    expect(result).toEqual({ attempted: 1, completed: 1, remainingIds: [] });
    expect(trigger).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalledWith(KV.rawPayloads);
    expect(
      await kv.get<CompressedObservation>(
        KV.observations(raw.sessionId),
        raw.id,
      ),
    ).toMatchObject({
      id: raw.id,
      sourceType: "prompt_submit",
      title: "prompt_submit",
    });
    expect(searchAdd).toHaveBeenCalledOnce();
    expect(
      await kv.list(KV.pendingCompression(raw.sessionId)),
    ).toHaveLength(0);
  });

  it("counts an already-compressed pending marker as recovered work", async () => {
    const kv = mockKV();
    const raw = rawObservation();
    await seedPending(kv, raw);
    await kv.set(KV.observations(raw.sessionId), raw.id, {
      id: raw.id,
      sessionId: raw.sessionId,
      timestamp: raw.timestamp,
      sourceType: raw.hookType,
      type: "conversation",
      title: "Already compressed",
      facts: [],
      narrative: "retain this",
      concepts: [],
      files: [],
      importance: 5,
    } satisfies CompressedObservation);

    const result = await drainPendingCompression(
      { trigger: vi.fn() } as never,
      kv as never,
      raw.sessionId,
    );

    expect(result).toEqual({ attempted: 0, completed: 1, remainingIds: [] });
    expect(
      await kv.get(KV.pendingCompression(raw.sessionId), raw.id),
    ).toBeNull();
  });

  it("deletes an expired raw payload after its compressed observation is searchable", async () => {
    const kv = mockKV();
    const raw = rawObservation();
    await storeRawObservation(kv as never, raw);
    await kv.set(KV.observations(raw.sessionId), raw.id, {
      id: raw.id,
      sessionId: raw.sessionId,
      timestamp: raw.timestamp,
      sourceType: raw.hookType,
      type: "conversation",
      title: "Already compressed",
      facts: [],
      narrative: "retain this",
      concepts: [],
      files: [],
      importance: 5,
    } satisfies CompressedObservation);

    const result = await drainPendingCompression(
      { trigger: vi.fn() } as never,
      kv as never,
      raw.sessionId,
      {
        rawPayloads: [raw],
        rawPayloadRetentionCutoff: "2026-07-17T10:00:00.000Z",
      },
    );

    expect(result).toEqual({ attempted: 0, completed: 1, remainingIds: [] });
    expect(await kv.get(KV.rawPayloads, raw.id)).toBeNull();
    expect(
      await kv.get(KV.rawPayloadsBySession(raw.sessionId), raw.id),
    ).toBeNull();
    expect(
      await kv.get<CompressedObservation>(KV.observations(raw.sessionId), raw.id),
    ).not.toBeNull();
  });

  it("does not resurrect an expired raw-only observation", async () => {
    const kv = mockKV();
    const raw: RawObservation = {
      id: "obs_raw_only",
      sessionId: "ses_pending",
      timestamp: "2026-07-16T10:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "read",
      toolInput: { filePath: "src/functions/observe.ts" },
      toolOutput: "source",
      raw: {},
    };
    await storeRawObservation(kv as never, raw);
    const trigger = vi.fn();

    const result = await drainPendingCompression(
      { trigger } as never,
      kv as never,
      raw.sessionId,
      {
        rawPayloads: [raw],
        rawPayloadRetentionCutoff: "2026-07-17T10:00:00.000Z",
      },
    );

    expect(result).toEqual({ attempted: 0, completed: 1, remainingIds: [] });
    expect(trigger).toHaveBeenCalledWith({
      function_id: "stream::delete",
      payload: {
        stream_name: "mem-live",
        group_id: "ses_pending",
        item_id: raw.id,
      },
    });
    expect(searchAdd).not.toHaveBeenCalled();
    expect(vectorAdd).not.toHaveBeenCalled();
    expect(await kv.get(KV.rawPayloads, raw.id)).toBeNull();
    expect(await kv.get(KV.observations(raw.sessionId), raw.id)).toBeNull();
  });

  it("retains raw-only data when stream retirement fails", async () => {
    const kv = mockKV();
    const raw: RawObservation = {
      id: "obs_raw_retry",
      sessionId: "ses_pending",
      timestamp: "2026-07-16T10:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "read",
      raw: {},
    };
    await storeRawObservation(kv as never, raw);
    const trigger = vi.fn().mockRejectedValue(new Error("stream unavailable"));

    const result = await drainPendingCompression(
      { trigger } as never,
      kv as never,
      raw.sessionId,
      {
        rawPayloads: [raw],
        rawPayloadRetentionCutoff: "2026-07-17T10:00:00.000Z",
      },
    );

    expect(result).toEqual({
      attempted: 0,
      completed: 0,
      remainingIds: [raw.id],
    });
    expect(await kv.get(KV.rawPayloads, raw.id)).toEqual(raw);
  });

  it("rebuilds command observations without vectorizing them", async () => {
    const kv = mockKV();
    const raw: RawObservation = {
      id: "obs_command",
      sessionId: "ses_pending",
      timestamp: "2026-07-16T10:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "bash",
      toolInput: { command: "npm test" },
      toolOutput: "passed",
      raw: {},
    };
    await seedPending(kv, raw);

    const result = await drainPendingCompression(
      { trigger: vi.fn() } as never,
      kv as never,
      raw.sessionId,
    );

    expect(result).toEqual({ attempted: 1, completed: 1, remainingIds: [] });
    expect(searchAdd).toHaveBeenCalledOnce();
    expect(vectorAdd).not.toHaveBeenCalled();
  });

  it("uses mem::compress when automatic compression is enabled", async () => {
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "true");
    const kv = mockKV();
    const raw = rawObservation();
    await seedPending(kv, raw);
    const trigger = vi.fn(async (request: { payload: unknown }) => {
      const payload = request.payload as {
        observationId: string;
        sessionId: string;
      };
      await kv.set(KV.observations(payload.sessionId), payload.observationId, {
        id: payload.observationId,
        sessionId: payload.sessionId,
        timestamp: raw.timestamp,
        sourceType: raw.hookType,
        type: "conversation",
        title: "Recovered observation",
        facts: [],
        narrative: "retain this",
        concepts: [],
        files: [],
        importance: 5,
      } satisfies CompressedObservation);
      return { success: true };
    });

    const result = await drainPendingCompression(
      { trigger } as never,
      kv as never,
      raw.sessionId,
    );

    expect(result.completed).toBe(1);
    expect(trigger).toHaveBeenCalledOnce();
    expect(
      await kv.list(KV.pendingCompression(raw.sessionId)),
    ).toHaveLength(0);
  });

  it("retains pending recovery until the durable observation is searchable", async () => {
    const kv = mockKV();
    const raw = rawObservation();
    await seedPending(kv, raw);
    searchAdd.mockImplementation(() => {
      throw new Error("search index unavailable");
    });

    const first = await drainPendingCompression(
      { trigger: vi.fn() } as never,
      kv as never,
      raw.sessionId,
    );

    expect(first.remainingIds).toEqual([raw.id]);
    expect(await kv.get(KV.observations(raw.sessionId), raw.id)).not.toBeNull();
    expect(
      await kv.get(KV.pendingCompression(raw.sessionId), raw.id),
    ).not.toBeNull();

    searchAdd.mockImplementation(() => {});
    const second = await drainPendingCompression(
      { trigger: vi.fn() } as never,
      kv as never,
      raw.sessionId,
    );

    expect(second).toEqual({ attempted: 0, completed: 1, remainingIds: [] });
    expect(searchIds.has(raw.id)).toBe(true);
    expect(
      await kv.get(KV.pendingCompression(raw.sessionId), raw.id),
    ).toBeNull();
  });

  it("removes stale pending entries without scanning raw history", async () => {
    const kv = mockKV();
    const raw = rawObservation();
    await kv.set(KV.pendingCompression(raw.sessionId), raw.id, {
      id: raw.id,
      sessionId: raw.sessionId,
    } satisfies PendingCompressionEntry);
    const list = vi.spyOn(kv, "list");

    const result = await drainPendingCompression(
      { trigger: vi.fn() } as never,
      kv as never,
      raw.sessionId,
    );

    expect(result).toEqual({ attempted: 0, completed: 0, remainingIds: [] });
    expect(list).not.toHaveBeenCalledWith(KV.rawPayloads);
    expect(
      await kv.list(KV.pendingCompression(raw.sessionId)),
    ).toHaveLength(0);
  });

  it("rolls back the pending entry when the raw write fails", async () => {
    const kv = mockKV();
    const raw = rawObservation();
    const originalSet = kv.set;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (scope === KV.rawPayloads) throw new Error("raw write failed");
      return originalSet(scope, key, value);
    };

    await expect(storeRawObservation(kv as never, raw)).rejects.toThrow(
      "raw write failed",
    );
    expect(
      await kv.list(KV.pendingCompression(raw.sessionId)),
    ).toHaveLength(0);
  });

  it("maintains a session-owned raw index through the raw lifecycle", async () => {
    const kv = mockKV();
    const raw = rawObservation();

    await storeRawObservation(kv as never, raw);

    expect(
      await kv.get(`mem:raw-payloads-by-session:${raw.sessionId}`, raw.id),
    ).toEqual({ id: raw.id, sessionId: raw.sessionId });

    await deleteRawObservation(kv as never, raw.sessionId, raw.id);

    expect(
      await kv.get(`mem:raw-payloads-by-session:${raw.sessionId}`, raw.id),
    ).toBeNull();
  });

  it("clears stale pending entries while using a sweep raw snapshot", async () => {
    const kv = mockKV();
    const raw = rawObservation();
    await kv.set(KV.pendingCompression(raw.sessionId), raw.id, {
      id: raw.id,
      sessionId: raw.sessionId,
    } satisfies PendingCompressionEntry);

    const result = await drainPendingCompression(
      { trigger: vi.fn() } as never,
      kv as never,
      raw.sessionId,
      { rawPayloads: [] },
    );

    expect(result).toEqual({ attempted: 0, completed: 0, remainingIds: [] });
    expect(
      await kv.list(KV.pendingCompression(raw.sessionId)),
    ).toHaveLength(0);
  });

  it("does not lose a pending marker while the raw write is in flight", async () => {
    const kv = mockKV();
    const raw = rawObservation();
    const setRecord = kv.set;
    let releaseRawWrite: () => void = () => {};
    const rawWriteBlocked = new Promise<void>((resolve) => {
      releaseRawWrite = resolve;
    });
    let markRawWriteStarted: () => void = () => {};
    const rawWriteStarted = new Promise<void>((resolve) => {
      markRawWriteStarted = resolve;
    });
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (scope === KV.rawPayloads && key === raw.id) {
        markRawWriteStarted();
        await rawWriteBlocked;
      }
      if (scope === KV.observations(raw.sessionId) && key === raw.id) {
        throw new Error("synthetic write failed");
      }
      return setRecord(scope, key, value);
    });

    const store = storeRawObservation(kv as never, raw);
    await rawWriteStarted;
    const drain = drainPendingCompression(
      { trigger: vi.fn() } as never,
      kv as never,
      raw.sessionId,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRawWrite();

    await store;
    const result = await drain;

    expect(result.remainingIds).toEqual([raw.id]);
    expect(await kv.get(KV.rawPayloads, raw.id)).toEqual(raw);
    expect(await kv.get(KV.observations(raw.sessionId), raw.id)).toBeNull();
    expect(
      await kv.get(KV.pendingCompression(raw.sessionId), raw.id),
    ).toEqual({ id: raw.id, sessionId: raw.sessionId });
  });

  it("keeps the raw owner when its pending marker cannot be deleted", async () => {
    const kv = mockKV();
    const raw = rawObservation();
    await seedPending(kv, raw);
    const deleteRecord = kv.delete;
    vi.spyOn(kv, "delete").mockImplementation(async (scope, key) => {
      if (scope === KV.pendingCompression(raw.sessionId) && key === raw.id) {
        throw new Error("pending delete failed");
      }
      await deleteRecord(scope, key);
    });

    await expect(
      deleteRawObservation(kv as never, raw.sessionId, raw.id),
    ).rejects.toThrow("pending delete failed");

    expect(await kv.get(KV.rawPayloads, raw.id)).toEqual(raw);
    expect(
      await kv.get(KV.pendingCompression(raw.sessionId), raw.id),
    ).not.toBeNull();
  });
});
