import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const imageRefMocks = vi.hoisted(() => {
  const decrementImageRef = vi.fn(async () => {});
  return {
    decrementImageRef,
    releaseImageRef: vi.fn(
      async (kv: unknown, sdk: unknown, imageRef: string) =>
        decrementImageRef(kv, sdk, imageRef),
    ),
    finalizeImageRefRelease: vi.fn(async () => {}),
  };
});
const { decrementImageRef, releaseImageRef, finalizeImageRefRelease } =
  imageRefMocks;

vi.mock("../src/functions/image-refs.js", () => ({
  decrementImageRef,
  releaseImageRef,
  finalizeImageRefRelease,
}));

import { registerGovernanceFunction } from "../src/functions/governance.js";
import { drainPendingCompression } from "../src/functions/pending-compression.js";
import {
  deleteImageBackedRecord,
  deleteObservationOwners,
  drainPendingImageReleases,
} from "../src/functions/image-owner.js";
import {
  getSearchIndex,
  setIndexPersistence,
} from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
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
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: Function,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
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
    releaseImageRef.mockReset();
    releaseImageRef.mockImplementation(
      async (kvArg: unknown, sdkArg: unknown, imageRef: string) =>
        decrementImageRef(kvArg, sdkArg, imageRef),
    );
    finalizeImageRefRelease.mockReset();
    finalizeImageRefRelease.mockResolvedValue(undefined);
    sdk = mockSdk();
    kv = mockKV();
    registerGovernanceFunction(sdk as never, kv as never);

    await kv.set("mem:memories", "mem_1", makeMemory("mem_1", "pattern"));
    await kv.set("mem:memories", "mem_2", makeMemory("mem_2", "bug"));
    await kv.set("mem:memories", "mem_3", makeMemory("mem_3", "pattern"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("keeps derived state when pending owner deletion still fails", async () => {
    const releaseId = `record:${KV.memories}:mem_1`;
    await kv.set(KV.accessLog, "mem_1", { memoryId: "mem_1" });
    await kv.set(KV.imageReleases, releaseId, {
      id: releaseId,
      refs: [],
      kind: "record",
      scope: KV.memories,
      recordId: "mem_1",
      owner: makeMemory("mem_1"),
    });
    const deleteRecord = kv.delete;
    vi.spyOn(kv, "delete").mockImplementation(async (scope, key) => {
      if (scope === KV.memories && key === "mem_1") {
        throw new Error("owner delete failed");
      }
      return deleteRecord(scope, key);
    });

    const result = await drainPendingImageReleases(sdk as never, kv as never);

    expect(result).toEqual({ completed: 0, failed: 1 });
    expect(await kv.get(KV.accessLog, "mem_1")).not.toBeNull();
    expect(await kv.get(KV.memories, "mem_1")).not.toBeNull();
  });

  it("retries derived cleanup before deleting the release journal", async () => {
    await kv.set(KV.accessLog, "mem_1", { memoryId: "mem_1" });
    const deleteRecord = kv.delete;
    let failAccessDelete = true;
    vi.spyOn(kv, "delete").mockImplementation(async (scope, key) => {
      if (failAccessDelete && scope === KV.accessLog && key === "mem_1") {
        failAccessDelete = false;
        throw new Error("access cleanup failed");
      }
      return deleteRecord(scope, key);
    });

    await expect(
      sdk.trigger("mem::governance-delete", { memoryIds: ["mem_1"] }),
    ).rejects.toThrow("access cleanup failed");

    expect(await kv.get(KV.memories, "mem_1")).toBeNull();
    expect(await kv.get(KV.accessLog, "mem_1")).not.toBeNull();
    expect(await kv.list(KV.imageReleases)).toHaveLength(1);

    const result = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["mem_1"],
    })) as { deleted: number };

    expect(result.deleted).toBe(1);
    expect(await kv.get(KV.accessLog, "mem_1")).toBeNull();
    expect(await kv.list(KV.imageReleases)).toHaveLength(0);
  });

  it("governance-delete releases memory image refs only after owner deletion", async () => {
    const imageRef = "/managed/memory.png";
    await kv.set(KV.memories, "mem_1", {
      ...makeMemory("mem_1"),
      imageRef,
    });
    const deleteRecord = kv.delete;
    let failOwnerDelete = true;
    vi.spyOn(kv, "delete").mockImplementation(async (scope, key) => {
      if (failOwnerDelete && scope === KV.memories && key === "mem_1") {
        failOwnerDelete = false;
        throw new Error("owner delete failed");
      }
      await deleteRecord(scope, key);
    });

    await expect(
      sdk.trigger("mem::governance-delete", { memoryIds: ["mem_1"] }),
    ).rejects.toThrow("owner delete failed");

    expect(await kv.get(KV.memories, "mem_1")).not.toBeNull();
    expect(decrementImageRef).not.toHaveBeenCalled();

    const result = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["mem_1"],
    })) as { success: boolean; deleted: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(decrementImageRef).toHaveBeenCalledTimes(1);
    expect(await kv.get(KV.memories, "mem_1")).toBeNull();
  });

  it("governance-delete serializes concurrent memory image ref release", async () => {
    const imageRef = "/managed/shared.png";
    await kv.set(KV.memories, "mem_1", {
      ...makeMemory("mem_1"),
      imageRef,
    });
    let releaseImageCleanup: () => void = () => {};
    const imageCleanupBlocked = new Promise<void>((resolve) => {
      releaseImageCleanup = resolve;
    });
    decrementImageRef.mockImplementationOnce(() => imageCleanupBlocked);

    const requests = [
      sdk.trigger("mem::governance-delete", { memoryIds: ["mem_1"] }),
      sdk.trigger("mem::governance-delete", { memoryIds: ["mem_1"] }),
    ];
    await vi.waitFor(() => expect(decrementImageRef).toHaveBeenCalledTimes(1));
    releaseImageCleanup();

    const results = (await Promise.all(requests)) as Array<{
      success: boolean;
      deleted: number;
    }>;

    expect(results.every((result) => result.success)).toBe(true);
    expect(results.reduce((total, result) => total + result.deleted, 0)).toBe(
      1,
    );
    expect(decrementImageRef).toHaveBeenCalledTimes(1);
  });

  it("deletes independent memory owners concurrently", async () => {
    const deleteRecord = kv.delete;
    let ownerDeletesStarted = 0;
    let markFirstDelete!: () => void;
    const firstDeleteStarted = new Promise<void>((resolve) => {
      markFirstDelete = resolve;
    });
    let releaseDeletes!: () => void;
    const deletesCanFinish = new Promise<void>((resolve) => {
      releaseDeletes = resolve;
    });
    vi.spyOn(kv, "delete").mockImplementation(async (scope, key) => {
      if (scope === KV.memories) {
        ownerDeletesStarted++;
        if (ownerDeletesStarted === 1) markFirstDelete();
        await deletesCanFinish;
      }
      return deleteRecord(scope, key);
    });

    const deleting = Promise.all([
      deleteImageBackedRecord(sdk as never, kv as never, KV.memories, "mem_1"),
      deleteImageBackedRecord(sdk as never, kv as never, KV.memories, "mem_2"),
    ]);
    await firstDeleteStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const concurrentStarts = ownerDeletesStarted;
    releaseDeletes();
    await deleting;

    expect(concurrentStarts).toBe(2);
  });

  it("governance-delete retries image ref release after owner deletion", async () => {
    const imageRef = "/managed/retry-release.png";
    await kv.set(KV.memories, "mem_1", {
      ...makeMemory("mem_1"),
      imageRef,
    });
    decrementImageRef.mockRejectedValueOnce(new Error("ref release failed"));

    await expect(
      sdk.trigger("mem::governance-delete", { memoryIds: ["mem_1"] }),
    ).rejects.toThrow("ref release failed");
    expect(await kv.get(KV.memories, "mem_1")).toBeNull();

    const retry = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["mem_1"],
    })) as { deleted: number };

    expect(retry.deleted).toBe(1);
    expect(decrementImageRef).toHaveBeenCalledTimes(2);
    expect(decrementImageRef).toHaveBeenLastCalledWith(kv, sdk, imageRef);
    expect(await kv.list(KV.imageReleases)).toHaveLength(0);
  });

  it("keeps release progress until ref token finalization succeeds", async () => {
    const imageRef = "/managed/finalize-retry.png";
    await kv.set(KV.memories, "mem_1", {
      ...makeMemory("mem_1"),
      imageRef,
    });
    finalizeImageRefRelease.mockRejectedValueOnce(
      new Error("token finalization failed"),
    );

    await expect(
      sdk.trigger("mem::governance-delete", { memoryIds: ["mem_1"] }),
    ).rejects.toThrow("token finalization failed");
    expect(await kv.get(KV.memories, "mem_1")).toBeNull();
    expect(await kv.list(KV.imageReleases)).toHaveLength(1);

    const retry = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["mem_1"],
    })) as { deleted: number };

    expect(retry.deleted).toBe(1);
    expect(releaseImageRef).toHaveBeenCalledTimes(1);
    expect(finalizeImageRefRelease).toHaveBeenCalledTimes(2);
    expect(await kv.list(KV.imageReleases)).toHaveLength(0);
  });

  it("governance-delete resumes an ownerless observation release journal", async () => {
    const imageRef = "/managed/observation-retry.png";
    await kv.set(KV.sessions, "ses_1", makeSession(1));
    await kv.set(KV.observations("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      title: "Capture image",
      imageRef,
    });
    decrementImageRef.mockRejectedValueOnce(new Error("ref release failed"));

    await expect(
      sdk.trigger("mem::governance-delete", { memoryIds: ["obs_1"] }),
    ).rejects.toThrow("ref release failed");
    expect(await kv.get(KV.observations("ses_1"), "obs_1")).toBeNull();

    const retry = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["obs_1"],
    })) as { deleted: number };

    expect(retry.deleted).toBe(1);
    expect(releaseImageRef).toHaveBeenCalledTimes(2);
    expect(await kv.list(KV.imageReleases)).toHaveLength(0);
    expect(
      (await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount,
    ).toBe(0);
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
    expect(
      (await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount,
    ).toBe(0);
  });

  it("observation deletion applies its session count journal once", async () => {
    await kv.set(KV.sessions, "ses_1", makeSession(2));
    await kv.set(KV.observations("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      title: "Edit auth",
    });
    const setRecord = kv.set;
    let rejectJournalProgress = true;
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (
        rejectJournalProgress &&
        scope === KV.imageReleases &&
        key === "observation:ses_1:obs_1" &&
        (value as { observationCountAdjusted?: boolean })
          .observationCountAdjusted
      ) {
        rejectJournalProgress = false;
        throw new Error("journal progress failed");
      }
      return setRecord(scope, key, value);
    });

    await expect(
      deleteObservationOwners(sdk as never, kv as never, "ses_1", "obs_1"),
    ).rejects.toThrow("journal progress failed");
    expect(
      (await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount,
    ).toBe(1);

    await deleteObservationOwners(sdk as never, kv as never, "ses_1", "obs_1");

    expect(
      (await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount,
    ).toBe(1);
  });

  it("preserves concurrent session fields while recording count progress", async () => {
    await kv.set(KV.sessions, "ses_1", makeSession(1));
    await kv.set(KV.observations("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      title: "Edit auth",
    });
    const getRecord = kv.get;
    const setRecord = kv.set;
    let injectCommit = true;
    vi.spyOn(kv, "get").mockImplementation(async (scope, key) => {
      const value = await getRecord(scope, key);
      if (injectCommit && scope === KV.sessions && key === "ses_1" && value) {
        injectCommit = false;
        await setRecord(KV.sessions, "ses_1", {
          ...(value as Session),
          commitShas: ["abc123"],
        });
      }
      return value;
    });

    await deleteObservationOwners(sdk as never, kv as never, "ses_1", "obs_1");

    expect((await kv.get<Session>(KV.sessions, "ses_1"))?.commitShas).toEqual([
      "abc123",
    ]);
  });

  it("waits for full session writers before adjusting observation count", async () => {
    await kv.set(KV.sessions, "ses_1", makeSession(1));
    await kv.set(KV.observations("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      title: "Edit auth",
    });
    let writerRead!: () => void;
    const writerDidRead = new Promise<void>((resolve) => {
      writerRead = resolve;
    });
    let releaseWriter!: () => void;
    const writerCanSet = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });

    const writer = withKeyedLock("session:ses_1", async () => {
      const snapshot = await kv.get<Session>(KV.sessions, "ses_1");
      writerRead();
      await writerCanSet;
      await kv.set(KV.sessions, "ses_1", {
        ...snapshot!,
        commitShas: ["abc123"],
      });
    });
    await writerDidRead;

    const deletion = deleteObservationOwners(
      sdk as never,
      kv as never,
      "ses_1",
      "obs_1",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(await kv.get(KV.observations("ses_1"), "obs_1")).not.toBeNull();
    releaseWriter();
    await Promise.all([writer, deletion]);

    const session = await kv.get<Session>(KV.sessions, "ses_1");
    expect(session?.observationCount).toBe(0);
    expect(session?.commitShas).toEqual(["abc123"]);
  });

  it("keeps the observation journal until its count token is cleared", async () => {
    await kv.set(KV.sessions, "ses_1", makeSession(1));
    await kv.set(KV.observations("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      title: "Edit auth",
    });
    const updateRecord = kv.update;
    let rejectTokenClear = true;
    vi.spyOn(kv, "update").mockImplementation(async (scope, key, ops) => {
      if (
        rejectTokenClear &&
        scope === KV.sessions &&
        key === "ses_1" &&
        ops.some(
          (op) =>
            op.path === "appliedObservationDeletionIds" &&
            Array.isArray(op.value) &&
            op.value.length === 0,
        )
      ) {
        rejectTokenClear = false;
        throw new Error("count token clear failed");
      }
      return updateRecord(scope, key, ops);
    });

    await expect(
      deleteObservationOwners(sdk as never, kv as never, "ses_1", "obs_1"),
    ).rejects.toThrow("count token clear failed");
    expect(await kv.list(KV.imageReleases)).toHaveLength(1);

    await deleteObservationOwners(sdk as never, kv as never, "ses_1", "obs_1");

    expect(await kv.list(KV.imageReleases)).toHaveLength(0);
    expect(
      (await kv.get<Session>(KV.sessions, "ses_1"))
        ?.appliedObservationDeletionIds,
    ).toEqual([]);
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
    expect(
      (await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount,
    ).toBe(1);
  });

  it("governance-delete releases observation image refs after every owner delete", async () => {
    const compressedImageRef = "/managed/compressed-image.png";
    const rawImageRef = "/managed/raw-image.png";
    await kv.set(KV.sessions, "ses_1", makeSession(1));
    await kv.set(KV.observations("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      title: "Capture image",
      imageRef: compressedImageRef,
    });
    await kv.set(KV.rawPayloads, "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      hookType: "post_tool_use",
      raw: {},
      imageData: rawImageRef,
    });
    await kv.set(KV.accessLog, "obs_1", { memoryId: "obs_1" });
    const deleteRecord = kv.delete;
    let failRawDelete = true;
    vi.spyOn(kv, "delete").mockImplementation(async (scope, key) => {
      if (failRawDelete && scope === KV.rawPayloads && key === "obs_1") {
        failRawDelete = false;
        throw new Error("raw owner delete failed");
      }
      await deleteRecord(scope, key);
    });

    await expect(
      sdk.trigger("mem::governance-delete", { memoryIds: ["obs_1"] }),
    ).rejects.toThrow("raw owner delete failed");

    expect(await kv.get(KV.observations("ses_1"), "obs_1")).toBeNull();
    expect(await kv.get(KV.rawPayloads, "obs_1")).not.toBeNull();
    expect(await kv.get(KV.accessLog, "obs_1")).not.toBeNull();
    expect(decrementImageRef).not.toHaveBeenCalled();
    expect(
      (await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount,
    ).toBe(1);

    const result = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["obs_1"],
    })) as { success: boolean; deleted: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(decrementImageRef).toHaveBeenCalledTimes(2);
    expect(decrementImageRef).toHaveBeenCalledWith(kv, sdk, compressedImageRef);
    expect(decrementImageRef).toHaveBeenCalledWith(kv, sdk, rawImageRef);
    expect(await kv.list(KV.imageReleases)).toHaveLength(0);
    expect(await kv.get(KV.observations("ses_1"), "obs_1")).toBeNull();
    expect(await kv.get(KV.rawPayloads, "obs_1")).toBeNull();
    expect(await kv.get(KV.accessLog, "obs_1")).toBeNull();
    expect(
      (await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount,
    ).toBe(0);
  });

  it("governance-delete serializes concurrent observation image ref release", async () => {
    const imageRef = "/managed/shared-observation.png";
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
    let releaseImageCleanup: () => void = () => {};
    const imageCleanupBlocked = new Promise<void>((resolve) => {
      releaseImageCleanup = resolve;
    });
    decrementImageRef.mockImplementationOnce(() => imageCleanupBlocked);

    const requests = [
      sdk.trigger("mem::governance-delete", { memoryIds: ["obs_1"] }),
      sdk.trigger("mem::governance-delete", { memoryIds: ["obs_1"] }),
    ];
    await vi.waitFor(() => expect(decrementImageRef).toHaveBeenCalledTimes(1));
    releaseImageCleanup();

    const results = (await Promise.all(requests)) as Array<{
      success: boolean;
      deleted: number;
    }>;

    expect(results.every((result) => result.success)).toBe(true);
    expect(results.reduce((total, result) => total + result.deleted, 0)).toBe(
      1,
    );
    expect(decrementImageRef).toHaveBeenCalledTimes(1);
    expect(
      (await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount,
    ).toBe(0);
  });

  it("governance-delete preserves concurrent observation count decrements", async () => {
    await kv.set(KV.sessions, "ses_1", makeSession(2));
    for (const id of ["obs_1", "obs_2"]) {
      await kv.set(KV.observations("ses_1"), id, {
        id,
        sessionId: "ses_1",
        title: id,
      });
    }
    const updateRecord = kv.update;
    let sessionUpdateCalls = 0;
    let releaseFirstUpdate: () => void = () => {};
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let markFirstUpdateStarted: () => void = () => {};
    const firstUpdateStarted = new Promise<void>((resolve) => {
      markFirstUpdateStarted = resolve;
    });
    vi.spyOn(kv, "update").mockImplementation(async (scope, key, ops) => {
      if (scope === KV.sessions && key === "ses_1") {
        sessionUpdateCalls++;
      }
      if (
        sessionUpdateCalls === 1 &&
        scope === KV.sessions &&
        key === "ses_1"
      ) {
        markFirstUpdateStarted();
        await firstUpdateBlocked;
      }
      return updateRecord(scope, key, ops);
    });

    const first = sdk.trigger("mem::governance-delete", {
      memoryIds: ["obs_1"],
    });
    await firstUpdateStarted;
    const second = sdk.trigger("mem::governance-delete", {
      memoryIds: ["obs_2"],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirstUpdate();
    await Promise.all([first, second]);

    expect(
      (await kv.get<Session>(KV.sessions, "ses_1"))?.observationCount,
    ).toBe(0);
  });

  it("observation deletion rejects a mismatched raw session", async () => {
    const imageRef = "/managed/session-mismatch.png";
    await kv.set(KV.observations("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      title: "Owned by session one",
      imageRef,
    });
    await kv.set(KV.rawPayloads, "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      hookType: "post_tool_use",
      raw: {},
      imageData: imageRef,
    });

    await expect(
      deleteObservationOwners(sdk as never, kv as never, "ses_2", "obs_1"),
    ).rejects.toThrow("observation session mismatch");

    expect(await kv.get(KV.observations("ses_1"), "obs_1")).not.toBeNull();
    expect(await kv.get(KV.rawPayloads, "obs_1")).not.toBeNull();
    expect(decrementImageRef).not.toHaveBeenCalled();
  });

  it("observation deletion rejects a mismatched compressed-only journal", async () => {
    await kv.set(KV.sessions, "ses_2", {
      ...makeSession(1),
      id: "ses_2",
    });
    await kv.set(KV.imageReleases, "observation:ses_2:obs_1", {
      id: "observation:ses_2:obs_1",
      refs: ["/managed/wrong-session.png"],
      kind: "observation",
      sessionId: "ses_1",
      observationId: "obs_1",
      observation: {
        id: "obs_1",
        sessionId: "ses_1",
        title: "Owned by session one",
      },
    });

    await expect(
      deleteObservationOwners(sdk as never, kv as never, "ses_2", "obs_1"),
    ).rejects.toThrow("observation session mismatch");

    expect(releaseImageRef).not.toHaveBeenCalled();
    expect(
      (await kv.get<Session>(KV.sessions, "ses_2"))?.observationCount,
    ).toBe(1);
  });

  it("governance-delete cannot race pending recovery into restoring an observation", async () => {
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
    const imageRef = "/managed/recovery-race.png";
    await kv.set(KV.sessions, "ses_1", makeSession(1));
    await kv.set(KV.rawPayloads, "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      timestamp: "2026-07-16T10:00:00.000Z",
      hookType: "post_tool_use",
      raw: {},
      imageData: imageRef,
    });
    await kv.set(KV.pendingCompression("ses_1"), "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
    });

    const setRecord = kv.set;
    let releaseObservationWrite: () => void = () => {};
    const observationWriteBlocked = new Promise<void>((resolve) => {
      releaseObservationWrite = resolve;
    });
    let markObservationWriteStarted: () => void = () => {};
    const observationWriteStarted = new Promise<void>((resolve) => {
      markObservationWriteStarted = resolve;
    });
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (scope === KV.observations("ses_1") && key === "obs_1") {
        markObservationWriteStarted();
        await observationWriteBlocked;
      }
      return setRecord(scope, key, value);
    });

    const recovery = drainPendingCompression(
      sdk as never,
      kv as never,
      "ses_1",
    );
    await observationWriteStarted;
    const deletion = sdk.trigger("mem::governance-delete", {
      memoryIds: ["obs_1"],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseObservationWrite();
    await Promise.all([recovery, deletion]);

    expect(await kv.get(KV.observations("ses_1"), "obs_1")).toBeNull();
    expect(await kv.get(KV.rawPayloads, "obs_1")).toBeNull();
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
    })) as {
      success: boolean;
      dryRun: boolean;
      wouldDelete: number;
      ids: string[];
    };

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

      await sdk.trigger("mem::governance-delete", {
        memoryIds: ["mem_1", "mem_2"],
      });

      expect(persistence.save).toHaveBeenCalledTimes(1);
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

      expect(persistence.save).toHaveBeenCalledTimes(1);
    });

    it("governance-bulk flushes once across internal chunks", async () => {
      const persistence = mockPersistence();
      setIndexPersistence(persistence);
      for (let index = 4; index <= 52; index++) {
        const memory = makeMemory(`mem_${index}`);
        await kv.set(KV.memories, memory.id, memory);
      }

      await sdk.trigger("mem::governance-bulk", { type: ["pattern"] });

      expect(persistence.save).toHaveBeenCalledTimes(1);
    });

    it("keeps bulk deletion journals when persistence fails", async () => {
      const persistence = mockPersistence();
      persistence.save.mockRejectedValueOnce(new Error("save failed"));
      setIndexPersistence(persistence);

      await expect(
        sdk.trigger("mem::governance-bulk", { type: ["pattern"] }),
      ).rejects.toThrow("save failed");

      expect(await kv.list(KV.imageReleases)).toHaveLength(2);

      const result = await drainPendingImageReleases(sdk as never, kv as never);

      expect(result).toEqual({ completed: 2, failed: 0 });
      expect(await kv.list(KV.imageReleases)).toHaveLength(0);
    });

    it("keeps bulk deletion journals when finalization fails", async () => {
      const persistence = mockPersistence();
      setIndexPersistence(persistence);
      const setRecord = kv.set.bind(kv);
      let failFinalization = true;
      vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
        if (
          failFinalization &&
          scope === KV.imageReleases &&
          (value as { derivedCleanupComplete?: boolean }).derivedCleanupComplete
        ) {
          failFinalization = false;
          throw new Error("finalization failed");
        }
        return setRecord(scope, key, value);
      });

      await expect(
        sdk.trigger("mem::governance-bulk", { type: ["pattern"] }),
      ).rejects.toThrow("finalization failed");

      expect(await kv.list(KV.imageReleases)).toHaveLength(2);

      const result = await drainPendingImageReleases(sdk as never, kv as never);

      expect(result).toEqual({ completed: 2, failed: 0 });
      expect(await kv.list(KV.imageReleases)).toHaveLength(0);
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
