import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: "abc1234\n", stderr: "" });
    },
  ),
}));

vi.mock("node:util", async () => {
  const actual = (await vi.importActual("node:util")) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    promisify: () => async () => ({ stdout: "abc1234\n", stderr: "" }),
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi
    .fn()
    .mockReturnValue('{"version":"0.4.0","sessions":[],"memories":[]}'),
}));

import { registerSnapshotFunction } from "../src/functions/snapshot.js";
import { withObservationSessionOwnerLock } from "../src/functions/image-owner.js";
import { KV } from "../src/state/schema.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
import {
  withObservationSessionOwnershipLock,
} from "../src/functions/observation-lock.js";
import type { Session, Memory, SnapshotMeta } from "../src/types.js";

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
  };
}

describe("Snapshot Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  const snapshotDir = "/tmp/agentmemory-snapshots";

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerSnapshotFunction(sdk as never, kv as never, snapshotDir);

    const session: Session = {
      id: "ses_1",
      project: "test",
      cwd: "/tmp",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set("mem:sessions", "ses_1", session);

    const mem: Memory = {
      id: "mem_1",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "pattern",
      title: "Test pattern",
      content: "Always test",
      concepts: [],
      files: [],
      sessionIds: ["ses_1"],
      strength: 5,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_1", mem);
  });

  it("snapshot-create serializes state and returns meta", async () => {
    const result = (await sdk.trigger("mem::snapshot-create", {
      message: "Test snapshot",
    })) as { success: boolean; snapshot: SnapshotMeta };

    expect(result.success).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.commitHash).toBe("abc1234");
    expect(result.snapshot.message).toBe("Test snapshot");
    expect(result.snapshot.stats.sessions).toBe(1);
    expect(result.snapshot.stats.memories).toBe(1);
  });

  it("snapshot-create excludes access logs without snapshot owners", async () => {
    await kv.set(KV.accessLog, "mem_1", {
      memoryId: "mem_1",
      count: 1,
      lastAt: "2026-07-16T20:00:00.000Z",
      recent: [1],
    });
    await kv.set(KV.accessLog, "orphan_1", {
      memoryId: "orphan_1",
      count: 1,
      lastAt: "2026-07-16T20:00:00.000Z",
      recent: [1],
    });

    await sdk.trigger("mem::snapshot-create", {});

    const serialized = vi
      .mocked(writeFileSync)
      .mock.calls.find(([path]) => String(path).endsWith("state.json"))?.[1];
    const state = JSON.parse(String(serialized)) as {
      accessLogs: Array<{ memoryId: string }>;
    };
    expect(state.accessLogs.map((log) => log.memoryId)).toEqual(["mem_1"]);
  });

  it("collects snapshot state without replace import interleaving", async () => {
    const listRecord = kv.list;
    let releaseMemoryRead!: () => void;
    const memoryReadCanFinish = new Promise<void>((resolve) => {
      releaseMemoryRead = resolve;
    });
    let markMemoryReadStarted!: () => void;
    const memoryReadStarted = new Promise<void>((resolve) => {
      markMemoryReadStarted = resolve;
    });
    let blockMemoryRead = true;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (blockMemoryRead && scope === KV.memories) {
        blockMemoryRead = false;
        markMemoryReadStarted();
        await memoryReadCanFinish;
      }
      return listRecord<T>(scope);
    };

    const snapshotting = sdk.trigger("mem::snapshot-create", {});
    await memoryReadStarted;

    let importEntered = false;
    const importing = withObservationSessionOwnershipLock(
      ["ses_1"],
      async () => {
        importEntered = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(importEntered).toBe(false);

    releaseMemoryRead();
    await Promise.all([snapshotting, importing]);
    expect(importEntered).toBe(true);

    const serialized = vi
      .mocked(writeFileSync)
      .mock.calls.find(([path]) => String(path).endsWith("state.json"))?.[1];
    const state = JSON.parse(String(serialized)) as {
      sessions: Session[];
      memories: Memory[];
    };
    expect(state.sessions.map((session) => session.id)).toEqual(["ses_1"]);
    expect(state.memories.map((memory) => memory.id)).toEqual(["mem_1"]);
  });

  it("snapshot-list returns snapshots from git log", async () => {
    const result = (await sdk.trigger("mem::snapshot-list", {})) as {
      snapshots: Array<{
        commitHash: string;
        createdAt: string;
        message: string;
      }>;
    };

    expect(result.snapshots).toBeDefined();
    expect(Array.isArray(result.snapshots)).toBe(true);
  });

  it("snapshot-restore requires commitHash", async () => {
    const result = (await sdk.trigger("mem::snapshot-restore", {})) as {
      success: boolean;
      error: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain("commitHash");
  });

  it("snapshot-restore loads state from commit", async () => {
    const result = (await sdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean; commitHash: string };

    expect(result.success).toBe(true);
    expect(result.commitHash).toBe("abc1234");
  });

  it("snapshot-restore serializes session rows with deletion receipts", async () => {
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({
        version: "0.4.0",
        sessions: [
          {
            id: "ses_1",
            project: "test",
            cwd: "/tmp",
            startedAt: "2026-02-01T00:00:00Z",
            status: "completed",
            observationCount: 1,
          },
        ],
        memories: [],
      }),
    );
    const setRecord = kv.set;
    let snapshotSetStarted!: () => void;
    const snapshotReachedSet = new Promise<void>((resolve) => {
      snapshotSetStarted = resolve;
    });
    let releaseSnapshotSet!: () => void;
    const snapshotCanSet = new Promise<void>((resolve) => {
      releaseSnapshotSet = resolve;
    });
    let blockSnapshotSet = true;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (blockSnapshotSet && scope === KV.sessions && key === "ses_1") {
        blockSnapshotSet = false;
        snapshotSetStarted();
        await snapshotCanSet;
      }
      return setRecord(scope, key, data);
    };

    const restoring = sdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    });
    await snapshotReachedSet;

    let deletionFinished = false;
    const deleting = withKeyedLock("session:ses_1", async () => {
      const session = await kv.get<Session>(KV.sessions, "ses_1");
      await kv.set(KV.sessions, "ses_1", {
        ...session!,
        observationCount: 0,
        appliedObservationDeletionIds: ["observation:ses_1:obs_1"],
      });
      deletionFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const deletionWaited = !deletionFinished;

    releaseSnapshotSet();
    await Promise.all([restoring, deleting]);

    expect(deletionWaited).toBe(true);
    expect(await kv.get<Session>(KV.sessions, "ses_1")).toMatchObject({
      observationCount: 0,
      appliedObservationDeletionIds: ["observation:ses_1:obs_1"],
    });
  });

  it("snapshot-restore keeps session rows and observations under one lock", async () => {
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({
        version: "0.4.0",
        sessions: [
          {
            id: "ses_1",
            project: "test",
            cwd: "/tmp",
            startedAt: "2026-02-01T00:00:00Z",
            status: "completed",
            observationCount: 1,
          },
        ],
        observations: {
          ses_1: [{ id: "obs_1", sessionId: "ses_1", title: "Restored" }],
        },
        memories: [],
      }),
    );
    const setRecord = kv.set;
    let markObservationWrite!: () => void;
    const observationWriteStarted = new Promise<void>((resolve) => {
      markObservationWrite = resolve;
    });
    let releaseObservationWrite!: () => void;
    const observationCanWrite = new Promise<void>((resolve) => {
      releaseObservationWrite = resolve;
    });
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (scope === KV.observations("ses_1") && key === "obs_1") {
        markObservationWrite();
        await observationCanWrite;
      }
      return setRecord(scope, key, data);
    };

    const restoring = sdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    });
    await observationWriteStarted;
    let deletionFinished = false;
    const deleting = withObservationSessionOwnerLock("ses_1", async () => {
      await kv.delete(KV.sessions, "ses_1");
      await kv.delete(KV.observations("ses_1"), "obs_1");
      deletionFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(deletionFinished).toBe(false);
    releaseObservationWrite();
    await Promise.all([restoring, deleting]);
    expect(await kv.get(KV.sessions, "ses_1")).toBeNull();
    expect(await kv.get(KV.observations("ses_1"), "obs_1")).toBeNull();
  });

  it("snapshot-restore keeps owners and access logs in one ownership scope", async () => {
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({
        version: "0.4.0",
        sessions: [
          {
            id: "ses_1",
            project: "test",
            cwd: "/tmp",
            startedAt: "2026-02-01T00:00:00Z",
            status: "completed",
            observationCount: 1,
          },
        ],
        observations: {
          ses_1: [{ id: "obs_1", sessionId: "ses_1", title: "Restored" }],
        },
        memories: [],
        accessLogs: [
          { memoryId: "obs_1", count: 1, lastAt: "", recent: [] },
          { memoryId: "orphan_1", count: 1, lastAt: "", recent: [] },
        ],
      }),
    );
    const setRecord = kv.set;
    let releaseAccessWrite = () => {};
    const accessWriteBlocked = new Promise<void>((resolve) => {
      releaseAccessWrite = resolve;
    });
    let markAccessWriteStarted = () => {};
    const accessWriteStarted = new Promise<void>((resolve) => {
      markAccessWriteStarted = resolve;
    });
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (scope === KV.accessLog && key === "obs_1") {
        markAccessWriteStarted();
        await accessWriteBlocked;
      }
      return setRecord(scope, key, data);
    };
    const restoring = sdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    });
    await accessWriteStarted;
    let deletionFinished = false;
    const deleting = withObservationSessionOwnerLock("ses_1", async () => {
      await kv.delete(KV.observations("ses_1"), "obs_1");
      await kv.delete(KV.accessLog, "obs_1");
      deletionFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(deletionFinished).toBe(false);
    releaseAccessWrite();
    await Promise.all([restoring, deleting]);
    expect(await kv.get(KV.observations("ses_1"), "obs_1")).toBeNull();
    expect(await kv.get(KV.accessLog, "obs_1")).toBeNull();
    expect(await kv.get(KV.accessLog, "orphan_1")).toBeNull();
  });

  it("snapshot-create records an audit entry", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Audit test" });

    const audits = await kv.list("mem:audit");
    expect(audits.length).toBe(1);
  });
});
