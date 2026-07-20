import { describe, it, expect, beforeEach, vi } from "vitest";

const configMocks = vi.hoisted(() => ({ autoCompress: false }));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/slots.js", () => ({
  isReflectEnabled: () => true,
}));

vi.mock("../src/config.js", () => ({
  isGraphExtractionEnabled: () => false,
  getAgentId: () => undefined,
  getEnvVar: () => undefined,
  isAutoCompressEnabled: () => configMocks.autoCompress,
}));

import { registerSessionSweepFunction } from "../src/functions/session-sweep.js";
import { registerMigrateFunction } from "../src/functions/migrate.js";
import { upsertSession } from "../src/functions/session-upsert.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import type {
  AuditEntry,
  CompressedObservation,
  RawObservation,
  Session,
  SessionSummary,
} from "../src/types.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import { KV } from "../src/state/schema.js";
import { withImageOwnershipLock } from "../src/functions/observation-lock.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const kv = {
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
      const existing = (store.get(scope)?.get(key) as Record<string, unknown>) ?? {};
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
  return kv;
}

type MockTriggerCall = {
  function_id: string;
  payload: unknown;
  action?: unknown;
};

function mockSdk() {
  const triggerCalls: MockTriggerCall[] = [];
  const functions = new Map<string, (data: unknown) => unknown>();
  const sdk = {
    triggerCalls,
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: (data: unknown) => unknown,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      input: { function_id: string; payload?: unknown; action?: unknown },
    ) => {
      triggerCalls.push({
        function_id: input.function_id,
        payload: input.payload,
        action: input.action,
      });
      const fn = functions.get(input.function_id);
      if (!fn) return undefined;
      return fn(input.payload);
    },
  };
  return sdk;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_1",
    project: "test-project",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: "active",
    observationCount: 1,
    ...overrides,
  };
}

const SESSIONS_SCOPE = "mem:sessions";
const SUMMARIES_SCOPE = "mem:summaries";
const AUDIT_SCOPE = "mem:audit";

describe("Session Sweep Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    configMocks.autoCompress = false;
    sdk = mockSdk();
    kv = mockKV();
    registerSessionSweepFunction(sdk as never, kv as never);
  });

  it("drains pending image releases during a live sweep", async () => {
    const releaseId = `record:${KV.memories}:mem_deleted`;
    await kv.set(KV.imageReleases, releaseId, {
      id: releaseId,
      refs: [],
      kind: "record",
      scope: KV.memories,
      recordId: "mem_deleted",
      owner: { id: "mem_deleted" },
    });

    await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    });

    expect(await kv.get(KV.imageReleases, releaseId)).toBeNull();
  });

  it("keeps replace imports out of pending compression recovery", async () => {
    const session = makeSession({
      id: "ses_pending_barrier",
      startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    });
    const raw: RawObservation = {
      id: "obs_pending_barrier",
      sessionId: session.id,
      timestamp: session.startedAt,
      hookType: "prompt_submit",
      raw: { prompt: "recover" },
      userPrompt: "recover",
    };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.rawPayloads, raw.id, raw);
    await kv.set(KV.pendingCompression(session.id), raw.id, {
      id: raw.id,
      sessionId: session.id,
    });

    const listRecord = kv.list;
    const pendingReadStarted = deferred();
    const releasePendingRead = deferred();
    let blockPendingRead = true;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (blockPendingRead && scope === KV.pendingCompression(session.id)) {
        blockPendingRead = false;
        pendingReadStarted.resolve();
        await releasePendingRead.promise;
      }
      return listRecord<T>(scope);
    };

    const sweeping = sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    });
    await pendingReadStarted.promise;

    let importEntered = false;
    const importing = withImageOwnershipLock(async () => {
      importEntered = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(importEntered).toBe(false);

    releasePendingRead.resolve();
    await Promise.all([sweeping, importing]);
    expect(importEntered).toBe(true);
  });

  it("sweeps active sessions older than the 6h default", async () => {
    const stale = makeSession({
      id: "ses_old",
      startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_old", stale);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    })) as {
      swept: string[];
      skipped: string[];
      failed: Array<{ sessionId: string; error: string }>;
      totalActive: number;
      maxAgeMs: number;
      dryRun: boolean;
    };

    expect(result.swept).toContain("ses_old");
    expect(result.skipped).not.toContain("ses_old");
    expect(result.failed).toHaveLength(0);
    expect(result.totalActive).toBe(1);
    expect(result.dryRun).toBe(false);

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_old");
    expect(stored?.status).toBe("completed");
    expect(stored?.endedAt).toBeDefined();
  });

  it("skips active sessions younger than the 6h default", async () => {
    const fresh = makeSession({
      id: "ses_young",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_young", fresh);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    })) as { swept: string[]; skipped: string[]; totalActive: number };

    expect(result.skipped).toContain("ses_young");
    expect(result.swept).not.toContain("ses_young");
    expect(result.totalActive).toBe(1);

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_young");
    expect(stored?.status).toBe("active");
    expect(stored?.endedAt).toBeUndefined();
  });

  it("skips legacy completed sessions whose activity anchor is <= endedAt (no post-close activity)", async () => {
    const done = makeSession({
      id: "ses_done",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
      status: "completed",
      endedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_done", done);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    })) as { swept: string[]; checkpointed?: string[]; skipped: string[] };

    expect(result.swept).not.toContain("ses_done");
    expect(result.checkpointed ?? []).not.toContain("ses_done");
    expect(result.skipped).toContain("ses_done");

    const stoppedTriggers = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::stopped",
    );
    const checkpointTriggers = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::checkpoint",
    );
    expect(stoppedTriggers).toHaveLength(0);
    expect(checkpointTriggers).toHaveLength(0);
  });

  it("dryRun returns swept list without writing KV or firing triggers", async () => {
    const stale = makeSession({
      id: "ses_dry",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_dry", stale);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { dryRun: true },
    })) as { swept: string[]; dryRun: boolean };

    expect(result.swept).toContain("ses_dry");
    expect(result.dryRun).toBe(true);

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_dry");
    expect(stored?.status).toBe("active");
    expect(stored?.endedAt).toBeUndefined();

    const stoppedTriggers = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::stopped",
    );
    expect(stoppedTriggers).toHaveLength(0);

    const auditEntries = await kv.list<AuditEntry>(AUDIT_SCOPE);
    expect(auditEntries.filter((e) => e.functionId === "mem::session-sweep")).toHaveLength(0);
  });

  it("respects custom maxAgeMs payload override", async () => {
    const twoHours = makeSession({
      id: "ses_2h",
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_2h", twoHours);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { maxAgeMs: 60 * 60 * 1000 },
    })) as { swept: string[]; maxAgeMs: number };

    expect(result.swept).toContain("ses_2h");
    expect(result.maxAgeMs).toBe(60 * 60 * 1000);
  });

  it("restricts sweep to provided sessionIds", async () => {
    const aSession = makeSession({
      id: "ses_a",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    const bSession = makeSession({
      id: "ses_b",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_a", aSession);
    await kv.set(SESSIONS_SCOPE, "ses_b", bSession);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_a"] },
    })) as { swept: string[]; skipped: string[] };

    expect(result.swept).toContain("ses_a");
    expect(result.swept).not.toContain("ses_b");

    const bStored = await kv.get<Session>(SESSIONS_SCOPE, "ses_b");
    expect(bStored?.status).toBe("active");
  });

  it("fires event::session::stopped exactly once per swept session", async () => {
    const aSession = makeSession({
      id: "ses_a",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    const bSession = makeSession({
      id: "ses_b",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_a", aSession);
    await kv.set(SESSIONS_SCOPE, "ses_b", bSession);

    await sdk.trigger({ function_id: "mem::session-sweep", payload: {} });

    const stoppedTriggers = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::stopped",
    );
    expect(stoppedTriggers).toHaveLength(2);

    const ids = stoppedTriggers
      .map((c) => (c.payload as { sessionId: string }).sessionId)
      .sort();
    expect(ids).toEqual(["ses_a", "ses_b"]);
    expect(stoppedTriggers.every((c) => (c.payload as { reason?: string }).reason === "sweep-stale")).toBe(true);

  });

  it("prefers session.updatedAt over session.startedAt when present", async () => {
    const recentlyActive = makeSession({
      id: "ses_recent",
      startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_recent", recentlyActive);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    })) as { swept: string[]; skipped: string[] };

    expect(result.skipped).toContain("ses_recent");
    expect(result.swept).not.toContain("ses_recent");

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_recent");
    expect(stored?.status).toBe("active");
  });

  it("records an audit entry per swept session", async () => {
    const stale = makeSession({
      id: "ses_audit",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_audit", stale);

    await sdk.trigger({ function_id: "mem::session-sweep", payload: {} });

    const auditEntries = await kv.list<AuditEntry>(AUDIT_SCOPE);
    const sweepAudits = auditEntries.filter(
      (e) => e.functionId === "mem::session-sweep",
    );

    expect(sweepAudits.length).toBeGreaterThan(0);
    expect(sweepAudits.some((e) => e.targetIds.includes("ses_audit"))).toBe(true);
  });

  it("continues sweeping when one session throws", async () => {
    const good = makeSession({
      id: "ses_good",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    const bad = makeSession({
      id: "ses_bad",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_good", good);
    await kv.set(SESSIONS_SCOPE, "ses_bad", bad);

    const originalUpdate = kv.update;
    kv.update = (async (
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ) => {
      if (key === "ses_bad") {
        throw new Error("simulated kv failure");
      }
      return originalUpdate(scope, key, ops);
    }) as typeof kv.update;

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    })) as {
      swept: string[];
      failed: Array<{ sessionId: string; error: string }>;
    };

    expect(result.swept).toContain("ses_good");
    expect(result.failed.map((f) => f.sessionId)).toContain("ses_bad");
  });
});

describe("Session Sweep Scheduling", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    configMocks.autoCompress = false;
    sdk = mockSdk();
    kv = mockKV();
    registerSessionSweepFunction(sdk as never, kv as never);
  });

  it("processes sessions with bounded parallelism", async () => {
    const batchStarted = deferred();
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    let started = 0;
    sdk.registerFunction("event::session::stopped", async () => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 4) batchStarted.resolve();
      await release.promise;
      active -= 1;
      return { success: true };
    });

    for (let index = 0; index < 6; index++) {
      const session = makeSession({
        id: `ses_parallel_${index}`,
        startedAt: new Date(
          Date.now() - 10 * 60 * 60 * 1000,
        ).toISOString(),
      });
      await kv.set(SESSIONS_SCOPE, session.id, session);
    }

    const sweep = sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    });
    await batchStarted.promise;
    expect(started).toBe(4);
    expect(maxActive).toBe(4);

    release.resolve();
    const result = (await sweep) as { swept: string[] };
    expect(result.swept).toHaveLength(6);
    expect(maxActive).toBe(4);
  });

  it("recovers session-owned pending payloads without scanning all raw payloads", async () => {
    registerMigrateFunction(sdk as never, kv as never);
    const staleAt = new Date(
      Date.now() - 10 * 60 * 60 * 1000,
    ).toISOString();
    for (const sessionId of ["ses_pending_a", "ses_pending_b"]) {
      await kv.set(
        SESSIONS_SCOPE,
        sessionId,
        makeSession({ id: sessionId, updatedAt: staleAt }),
      );
      const raw: RawObservation = {
        id: `obs_${sessionId}`,
        sessionId,
        timestamp: staleAt,
        hookType: "prompt_submit",
        raw: { prompt: sessionId },
        userPrompt: sessionId,
      };
      await kv.set(KV.rawPayloads, raw.id, raw);
      await kv.set(KV.pendingCompression(sessionId), raw.id, {
        id: raw.id,
        sessionId,
      });
    }
    await sdk.trigger({
      function_id: "mem::migrate",
      payload: { step: "raw-payloads-by-session" },
    });

    let rawPayloadListCount = 0;
    const originalList = kv.list;
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.rawPayloads) rawPayloadListCount += 1;
      return originalList<T>(scope);
    }) as typeof kv.list;
    sdk.registerFunction("mem::compress", async (payload: unknown) => {
      const { observationId, sessionId, raw } = payload as {
        observationId: string;
        sessionId: string;
        raw: RawObservation;
      };
      const compressed: CompressedObservation = {
        id: observationId,
        sessionId,
        timestamp: raw.timestamp,
        sourceType: raw.hookType,
        type: "conversation",
        title: "Recovered pending observation",
        facts: [],
        narrative: raw.userPrompt ?? "",
        concepts: [],
        files: [],
        importance: 5,
      };
      await kv.set(KV.observations(sessionId), observationId, compressed);
      return { success: true };
    });
    sdk.registerFunction("event::session::stopped", async () => ({
      success: true,
    }));

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    })) as { swept: string[]; failed: unknown[] };

    expect(rawPayloadListCount).toBe(0);
    expect(result.swept.sort()).toEqual(["ses_pending_a", "ses_pending_b"]);
    expect(result.failed).toHaveLength(0);
    const stoppedCalls = sdk.triggerCalls.filter(
      (call) => call.function_id === "event::session::stopped",
    );
    expect(stoppedCalls).toHaveLength(2);
    expect(
      stoppedCalls.every(
        (call) =>
          (call.payload as {
            until?: string;
            pendingCompressionDrained?: boolean;
            pendingCompressionRecovered?: boolean;
          }).until === undefined &&
          (call.payload as { pendingCompressionDrained?: boolean })
            .pendingCompressionDrained === true &&
          (call.payload as { pendingCompressionRecovered?: boolean })
            .pendingCompressionRecovered === true,
      ),
    ).toBe(true);
  });

  it("backfills legacy raw payloads once then sweeps them without a global scan", async () => {
    configMocks.autoCompress = true;
    registerMigrateFunction(sdk as never, kv as never);
    const sessionId = "ses_legacy_raw";
    const staleAt = new Date(
      Date.now() - 10 * 60 * 60 * 1000,
    ).toISOString();
    const raw: RawObservation = {
      id: "obs_legacy_raw",
      sessionId,
      timestamp: staleAt,
      hookType: "prompt_submit",
      raw: { prompt: "legacy raw payload" },
      userPrompt: "legacy raw payload",
    };
    await kv.set(
      KV.sessions,
      sessionId,
      makeSession({ id: sessionId, updatedAt: staleAt }),
    );
    await kv.set(KV.rawPayloads, raw.id, raw);
    await kv.set(KV.pendingCompression(sessionId), raw.id, {
      id: raw.id,
      sessionId,
    });
    const compressedRaw: RawObservation = {
      ...raw,
      id: "obs_legacy_compressed_raw",
      raw: { prompt: "legacy compressed raw payload" },
      userPrompt: "legacy compressed raw payload",
    };
    await kv.set(KV.rawPayloads, compressedRaw.id, compressedRaw);
    await kv.set(KV.observations(sessionId), compressedRaw.id, {
      id: compressedRaw.id,
      sessionId,
      timestamp: staleAt,
      sourceType: compressedRaw.hookType,
      type: "conversation",
      title: "Legacy compressed observation",
      facts: [],
      narrative: compressedRaw.userPrompt ?? "",
      concepts: [],
      files: [],
      importance: 5,
    } satisfies CompressedObservation);
    sdk.registerFunction("mem::compress", async () => {
      await kv.set(KV.observations(sessionId), raw.id, {
        id: raw.id,
        sessionId,
        timestamp: raw.timestamp,
        sourceType: raw.hookType,
        type: "conversation",
        title: "Recovered legacy raw payload",
        facts: [],
        narrative: raw.userPrompt ?? "",
        concepts: [],
        files: [],
        importance: 5,
      } satisfies CompressedObservation);
      return { success: true };
    });
    const list = vi.spyOn(kv, "list");

    const firstMigration = (await sdk.trigger({
      function_id: "mem::migrate",
      payload: { step: "raw-payloads-by-session" },
    })) as { success: boolean; indexed?: number; alreadyComplete?: boolean };
    const secondMigration = (await sdk.trigger({
      function_id: "mem::migrate",
      payload: { step: "raw-payloads-by-session" },
    })) as { success: boolean; indexed?: number; alreadyComplete?: boolean };

    expect(firstMigration).toMatchObject({ success: true, indexed: 2 });
    expect(secondMigration).toMatchObject({
      success: true,
      indexed: 2,
      alreadyComplete: true,
    });
    expect(
      list.mock.calls.filter(([scope]) => scope === KV.rawPayloads),
    ).toHaveLength(0);
    const pendingListCall = list.mock.calls.findIndex(
      ([scope]) => scope === KV.pendingCompression(sessionId),
    );
    const observationListCall = list.mock.calls.findIndex(
      ([scope]) => scope === KV.observations(sessionId),
    );
    expect(pendingListCall).toBeLessThan(observationListCall);
    expect(
      await kv.get(KV.rawPayloadsBySession(sessionId), compressedRaw.id),
    ).not.toBeNull();
    list.mockClear();

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId] },
    })) as { swept: string[]; failed: unknown[] };

    expect(result.swept).toEqual([sessionId]);
    expect(result.failed).toHaveLength(0);
    expect(list).not.toHaveBeenCalledWith(KV.rawPayloads);
    expect(await kv.get(KV.observations(sessionId), raw.id)).not.toBeNull();
    expect(
      sdk.triggerCalls.find(
        (call) => call.function_id === "event::session::stopped",
      )?.payload,
    ).toMatchObject({
      pendingCompressionRecovered: true,
      until: undefined,
    });
  });

  it("does not globally scan raw payloads during a live sweep", async () => {
    const sessionId = "ses_unindexed_legacy_raw";
    const staleAt = new Date(
      Date.now() - 10 * 60 * 60 * 1000,
    ).toISOString();
    const raw: RawObservation = {
      id: "obs_unindexed_legacy_raw",
      sessionId,
      timestamp: staleAt,
      hookType: "prompt_submit",
      raw: { prompt: "unindexed legacy raw payload" },
      userPrompt: "unindexed legacy raw payload",
    };
    await kv.set(
      KV.sessions,
      sessionId,
      makeSession({ id: sessionId, updatedAt: staleAt }),
    );
    await kv.set(KV.rawPayloads, raw.id, raw);
    const list = vi.spyOn(kv, "list");

    const first = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId] },
    })) as { swept: string[]; failed: unknown[] };

    expect(first.swept).toEqual([sessionId]);
    expect(first.failed).toHaveLength(0);
    expect(list).not.toHaveBeenCalledWith(KV.rawPayloads);
  });

  it("allows observations during consolidation and defers finalization", async () => {
    registerObserveFunction(sdk as never, kv as never);
    const staleAt = new Date(
      Date.now() - 10 * 60 * 60 * 1000,
    ).toISOString();
    const sessionId = "ses_live_finalize";
    await kv.set(
      SESSIONS_SCOPE,
      sessionId,
      makeSession({ id: sessionId, updatedAt: staleAt }),
    );

    const consolidationStarted = deferred();
    const finishConsolidation = deferred();
    sdk.registerFunction("event::session::stopped", async () => {
      consolidationStarted.resolve();
      await finishConsolidation.promise;
      return { success: true };
    });

    const sweep = sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId] },
    });
    await consolidationStarted.promise;

    const observation = sdk.trigger({
      function_id: "mem::observe",
      payload: {
        sessionId,
        project: "test-project",
        cwd: "/tmp",
        hookType: "prompt_submit",
        timestamp: new Date().toISOString(),
        data: { prompt: "captured during finalization" },
      },
    });
    let observationTimeout: ReturnType<typeof setTimeout> | undefined;
    const observedBeforeConsolidation = await Promise.race([
      observation.then(() => {
        if (observationTimeout) clearTimeout(observationTimeout);
        return true;
      }),
      new Promise<boolean>((resolve) => {
        observationTimeout = setTimeout(() => resolve(false), 250);
      }),
    ]);

    finishConsolidation.resolve();
    const result = (await sweep) as {
      swept: string[];
      checkpointed: string[];
      failed: unknown[];
    };
    await observation;

    expect(observedBeforeConsolidation).toBe(true);
    expect(result.swept).not.toContain(sessionId);
    expect(result.checkpointed).toContain(sessionId);
    expect(result.failed).toHaveLength(0);
    const stored = await kv.get<Session>(SESSIONS_SCOPE, sessionId);
    expect(stored?.status).toBe("active");
    expect(stored?.endedAt).toBeUndefined();
    expect(stored?.lastCheckpointAt).toBe(staleAt);
    expect(stored?.updatedAt).not.toBe(staleAt);
  });

  it("does not finalize a completed session resumed during pending compression", async () => {
    configMocks.autoCompress = true;
    const staleAt = new Date(
      Date.now() - 10 * 60 * 60 * 1000,
    ).toISOString();
    const sessionId = "ses_resumed_during_sweep";
    await kv.set(
      SESSIONS_SCOPE,
      sessionId,
      makeSession({
        id: sessionId,
        updatedAt: staleAt,
        status: "completed",
        endedAt: staleAt,
        lastCheckpointAt: staleAt,
      }),
    );
    const raw: RawObservation = {
      id: "obs_resume_race",
      sessionId,
      timestamp: staleAt,
      hookType: "prompt_submit",
      raw: { prompt: "resume race" },
      userPrompt: "resume race",
    };
    await kv.set(KV.rawPayloads, raw.id, raw);
    await kv.set(KV.pendingCompression(sessionId), raw.id, {
      id: raw.id,
      sessionId,
    });

    const compressionStarted = deferred();
    const releaseCompression = deferred();
    sdk.registerFunction("mem::compress", async () => {
      compressionStarted.resolve();
      await releaseCompression.promise;
      await kv.set<CompressedObservation>(KV.observations(sessionId), raw.id, {
        id: raw.id,
        sessionId,
        timestamp: staleAt,
        sourceType: raw.hookType,
        type: "conversation",
        title: "Resume race",
        facts: [],
        narrative: "resume race",
        concepts: [],
        files: [],
        importance: 5,
      });
      return { success: true };
    });

    const sweep = sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId] },
    });
    await compressionStarted.promise;

    const resumed = await upsertSession(kv as never, {
      sessionId,
      project: "test-project",
      cwd: "/tmp",
      resumed: true,
    });
    releaseCompression.resolve();
    const result = (await sweep) as {
      swept: string[];
      checkpointed: string[];
      skipped: string[];
      failed: unknown[];
    };

    expect(resumed.session?.status).toBe("active");
    expect(resumed.session?.updatedAt).not.toBe(staleAt);
    expect(result.swept).not.toContain(sessionId);
    expect(result.checkpointed).not.toContain(sessionId);
    expect(result.skipped).toContain(sessionId);
    expect(result.failed).toHaveLength(0);
    const stored = await kv.get<Session>(SESSIONS_SCOPE, sessionId);
    expect(stored?.status).toBe("active");
    expect(stored?.endedAt).toBe(staleAt);
    expect(stored?.updatedAt).toBe(resumed.session?.updatedAt);
  });

  it("serializes overlapping sweep requests", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    sdk.registerFunction(
      "event::session::stopped",
      async (payload: unknown) => {
        const sessionId = (payload as { sessionId: string }).sessionId;
        calls.push(sessionId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (sessionId === "ses_first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        active -= 1;
        return { success: true };
      },
    );

    const staleAt = new Date(
      Date.now() - 10 * 60 * 60 * 1000,
    ).toISOString();
    await kv.set(
      SESSIONS_SCOPE,
      "ses_first",
      makeSession({ id: "ses_first", startedAt: staleAt }),
    );
    await kv.set(
      SESSIONS_SCOPE,
      "ses_second",
      makeSession({ id: "ses_second", startedAt: staleAt }),
    );

    const first = sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_first"] },
    });
    await firstStarted.promise;
    const second = sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_second"] },
    });
    await Promise.resolve();
    expect(calls).toEqual(["ses_first"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(calls).toEqual(["ses_first", "ses_second"]);
    expect(maxActive).toBe(1);
  });
});

describe("Session Sweep - Option K checkpoint path", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerSessionSweepFunction(sdk as never, kv as never);
  });

  it("active path sets lastCheckpointAt=activityAnchor when transitioning to completed", async () => {
    const anchor = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const stale = makeSession({
      id: "ses_active_anchor",
      startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_active_anchor", stale);

    await sdk.trigger({ function_id: "mem::session-sweep", payload: {} });

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_active_anchor");
    expect(stored?.status).toBe("completed");
    expect(stored?.endedAt).toBeDefined();
    expect(stored?.lastCheckpointAt).toBe(anchor);
  });

  it("S2 - checkpoints completed session with post-close activity after another 6h", async () => {
    const day1Anchor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const day2Anchor = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_resumed",
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      updatedAt: day2Anchor,
      status: "completed",
      endedAt: new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString(),
      lastCheckpointAt: day1Anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_resumed", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    })) as { swept: string[]; checkpointed: string[]; skipped: string[] };

    expect(result.checkpointed).toContain("ses_resumed");
    expect(result.swept).not.toContain("ses_resumed");
    expect(result.skipped).not.toContain("ses_resumed");
  });

  it("checkpoint path preserves status=completed and endedAt, advances lastCheckpointAt", async () => {
    const day1Anchor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const day2Anchor = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const originalEndedAt = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_preserve",
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      updatedAt: day2Anchor,
      status: "completed",
      endedAt: originalEndedAt,
      lastCheckpointAt: day1Anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_preserve", session);

    await sdk.trigger({ function_id: "mem::session-sweep", payload: {} });

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_preserve");
    expect(stored?.status).toBe("completed");
    expect(stored?.endedAt).toBe(originalEndedAt);
    expect(stored?.lastCheckpointAt).toBe(day2Anchor);
  });

  it("checkpoint path fires event::session::checkpoint (not ::stopped) with since+until", async () => {
    const day1Anchor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const day2Anchor = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_event",
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      updatedAt: day2Anchor,
      status: "completed",
      endedAt: new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString(),
      lastCheckpointAt: day1Anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_event", session);

    await sdk.trigger({ function_id: "mem::session-sweep", payload: {} });

    const stoppedTriggers = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::stopped",
    );
    const checkpointTriggers = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::checkpoint",
    );
    expect(stoppedTriggers).toHaveLength(0);
    expect(checkpointTriggers).toHaveLength(1);
    expect((checkpointTriggers[0].payload as any).since).toBe(day1Anchor);
    expect((checkpointTriggers[0].payload as any).until).toBe(day2Anchor);
    expect((checkpointTriggers[0].payload as any).reason).toBe("sweep-catchup");
  });

  it("S1 - second sweep skips completed session whose activity anchor <= lastCheckpointAt", async () => {
    const anchor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_no_resume",
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      updatedAt: anchor,
      status: "completed",
      endedAt: new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString(),
      lastCheckpointAt: anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_no_resume", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    })) as { swept: string[]; checkpointed: string[]; skipped: string[] };

    expect(result.checkpointed).not.toContain("ses_no_resume");
    expect(result.swept).not.toContain("ses_no_resume");
    expect(result.skipped).toContain("ses_no_resume");
  });

  it("does not reconsolidate a completed session after its recovered pending marker is cleared", async () => {
    const anchor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sessionId = "ses_recovered_pending_once";
    const raw: RawObservation = {
      id: "obs_recovered_pending_once",
      sessionId,
      timestamp: anchor,
      hookType: "prompt_submit",
      raw: { prompt: "already compressed" },
      userPrompt: "already compressed",
    };
    const observation: CompressedObservation = {
      id: raw.id,
      sessionId,
      timestamp: raw.timestamp,
      sourceType: raw.hookType,
      type: "conversation",
      title: "Recovered pending observation",
      facts: [],
      narrative: raw.userPrompt ?? "",
      concepts: [],
      files: [],
      importance: 5,
    };
    await kv.set(
      SESSIONS_SCOPE,
      sessionId,
      makeSession({
        id: sessionId,
        startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        updatedAt: anchor,
        status: "completed",
        endedAt: new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString(),
        lastCheckpointAt: anchor,
      }),
    );
    await kv.set(KV.rawPayloads, raw.id, raw);
    await kv.set(KV.rawPayloadsBySession(sessionId), raw.id, {
      id: raw.id,
      sessionId,
    });
    await kv.set(KV.observations(sessionId), observation.id, observation);
    await kv.set(KV.pendingCompression(sessionId), raw.id, {
      id: raw.id,
      sessionId,
    });

    const first = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId] },
    })) as { checkpointed: string[] };

    expect(first.checkpointed).toEqual([sessionId]);
    expect(await kv.get(KV.pendingCompression(sessionId), raw.id)).toBeNull();
    const checkpointCount = sdk.triggerCalls.filter(
      (call) => call.function_id === "event::session::checkpoint",
    ).length;

    const second = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId] },
    })) as { checkpointed: string[]; skipped: string[] };

    expect(second.checkpointed).toHaveLength(0);
    expect(second.skipped).toContain(sessionId);
    expect(
      sdk.triggerCalls.filter(
        (call) => call.function_id === "event::session::checkpoint",
      ),
    ).toHaveLength(checkpointCount);
  });

  it("records session_checkpoint audit operation for checkpoint path", async () => {
    const day1Anchor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const day2Anchor = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_audit_cp",
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      updatedAt: day2Anchor,
      status: "completed",
      endedAt: new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString(),
      lastCheckpointAt: day1Anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_audit_cp", session);

    await sdk.trigger({ function_id: "mem::session-sweep", payload: {} });

    const auditEntries = await kv.list<AuditEntry>(AUDIT_SCOPE);
    const checkpointAudits = auditEntries.filter(
      (e) => e.operation === "session_checkpoint",
    );
    expect(checkpointAudits.length).toBeGreaterThan(0);
    expect(checkpointAudits[0].targetIds).toContain("ses_audit_cp");
  });
});

describe("Session Sweep - restart safety", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerSessionSweepFunction(sdk as never, kv as never);
    registerEventTriggers(sdk as never, kv as never);
  });

  function registerSuccessStubs() {
    sdk.registerFunction("mem::summarize", async () => ({ success: true }));
    sdk.registerFunction("mem::slot-reflect", async () => ({ success: true, applied: 0 }));
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));
  }

  it("active path: event::session::stopped fires BEFORE kv.update mutates session state", async () => {
    registerSuccessStubs();
    const stale = makeSession({
      id: "ses_order",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_order", stale);

    const events: string[] = [];
    const originalUpdate = kv.update;
    kv.update = (async (
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ) => {
      if (scope === SESSIONS_SCOPE && key === "ses_order") events.push("kv.update");
      return originalUpdate(scope, key, ops);
    }) as typeof kv.update;

    const originalTrigger = sdk.trigger;
    sdk.trigger = (async (input: {
      function_id: string;
      payload?: unknown;
      action?: unknown;
    }) => {
      if (input.function_id === "event::session::stopped") events.push("trigger");
      return originalTrigger(input);
    }) as typeof sdk.trigger;

    await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_order"] },
    });

    const triggerIdx = events.indexOf("trigger");
    const updateIdx = events.indexOf("kv.update");
    expect(triggerIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(triggerIdx).toBeLessThan(updateIdx);
  });

  it("stale child session gets summary-only consolidation before finalization", async () => {
    registerSuccessStubs();
    const sessionId = "ses_child_sweep";
    await kv.set(SESSIONS_SCOPE, sessionId, makeSession({
      id: sessionId,
      parentSessionId: "ses_parent",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    }));

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId] },
    })) as { swept: string[]; failed: Array<{ sessionId: string }> };

    expect(result.swept).toContain(sessionId);
    expect(result.failed).toHaveLength(0);
    const ids = sdk.triggerCalls.map((call) => call.function_id);
    expect(ids).toContain("mem::summarize");
    expect(ids).not.toContain("mem::slot-reflect");
    expect(ids).not.toContain("mem::graph-extract");
  });

  it("active sweep: crashing summarize leaves KV untouched and routes session to failed", async () => {
    sdk.registerFunction("mem::summarize", async () => {
      throw new Error("simulated pipeline failure");
    });
    sdk.registerFunction("mem::slot-reflect", async () => ({ success: true }));
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));

    const stale = makeSession({
      id: "ses_crash_active",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_crash_active", stale);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_crash_active"] },
    })) as {
      swept: string[];
      failed: Array<{ sessionId: string; error: string }>;
    };

    expect(result.swept).not.toContain("ses_crash_active");
    expect(result.failed.map((f) => f.sessionId)).toContain("ses_crash_active");

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_crash_active");
    expect(stored?.status).toBe("active");
    expect(stored?.endedAt).toBeUndefined();
    expect(stored?.lastCheckpointAt).toBeUndefined();
  });

  it("active sweep: crashed pipeline is replayed on next sweep after handler is fixed", async () => {
    let summarizeShouldFail = true;
    sdk.registerFunction("mem::summarize", async () => {
      if (summarizeShouldFail) throw new Error("simulated pipeline failure");
      return { success: true };
    });
    sdk.registerFunction("mem::slot-reflect", async () => ({ success: true }));
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));

    const stale = makeSession({
      id: "ses_replay_active",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_replay_active", stale);

    const r1 = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_replay_active"] },
    })) as { swept: string[]; failed: Array<{ sessionId: string }> };
    expect(r1.failed.map((f) => f.sessionId)).toContain("ses_replay_active");
    const stored1 = await kv.get<Session>(SESSIONS_SCOPE, "ses_replay_active");
    expect(stored1?.status).toBe("active");

    summarizeShouldFail = false;

    const r2 = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_replay_active"] },
    })) as { swept: string[]; failed: Array<{ sessionId: string }> };
    expect(r2.swept).toContain("ses_replay_active");
    expect(r2.failed).toHaveLength(0);
    const stored2 = await kv.get<Session>(SESSIONS_SCOPE, "ses_replay_active");
    expect(stored2?.status).toBe("completed");
    expect(stored2?.endedAt).toBeDefined();
    expect(stored2?.lastCheckpointAt).toBeDefined();
  });

  it("checkpoint sweep: crashing summarize leaves lastCheckpointAt unchanged and routes session to failed", async () => {
    sdk.registerFunction("mem::summarize", async () => {
      throw new Error("simulated pipeline failure");
    });
    sdk.registerFunction("mem::slot-reflect", async () => ({ success: true }));
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));

    const day1Anchor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const day2Anchor = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const originalEndedAt = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_crash_cp",
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      updatedAt: day2Anchor,
      status: "completed",
      endedAt: originalEndedAt,
      lastCheckpointAt: day1Anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_crash_cp", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_crash_cp"] },
    })) as {
      checkpointed: string[];
      failed: Array<{ sessionId: string; error: string }>;
    };

    expect(result.checkpointed).not.toContain("ses_crash_cp");
    expect(result.failed.map((f) => f.sessionId)).toContain("ses_crash_cp");

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_crash_cp");
    expect(stored?.lastCheckpointAt).toBe(day1Anchor);
    expect(stored?.endedAt).toBe(originalEndedAt);
  });

  it("checkpoint sweep: crashed pipeline is replayed on next sweep after handler is fixed", async () => {
    let summarizeShouldFail = true;
    sdk.registerFunction("mem::summarize", async () => {
      if (summarizeShouldFail) throw new Error("simulated pipeline failure");
      return { success: true };
    });
    sdk.registerFunction("mem::slot-reflect", async () => ({ success: true }));
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));

    const day1Anchor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const day2Anchor = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_replay_cp",
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      updatedAt: day2Anchor,
      status: "completed",
      endedAt: new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString(),
      lastCheckpointAt: day1Anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_replay_cp", session);

    const r1 = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_replay_cp"] },
    })) as { checkpointed: string[]; failed: Array<{ sessionId: string }> };
    expect(r1.failed.map((f) => f.sessionId)).toContain("ses_replay_cp");
    const stored1 = await kv.get<Session>(SESSIONS_SCOPE, "ses_replay_cp");
    expect(stored1?.lastCheckpointAt).toBe(day1Anchor);

    summarizeShouldFail = false;

    const r2 = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_replay_cp"] },
    })) as { checkpointed: string[]; failed: Array<{ sessionId: string }> };
    expect(r2.checkpointed).toContain("ses_replay_cp");
    expect(r2.failed).toHaveLength(0);
    const stored2 = await kv.get<Session>(SESSIONS_SCOPE, "ses_replay_cp");
    expect(stored2?.lastCheckpointAt).toBe(day2Anchor);
  });

  it("idempotent: re-running sweep on a freshly swept session is a no-op", async () => {
    registerSuccessStubs();
    const stale = makeSession({
      id: "ses_idempotent",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_idempotent", stale);

    const r1 = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_idempotent"] },
    })) as { swept: string[] };
    expect(r1.swept).toContain("ses_idempotent");
    const stoppedAfter1 = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::stopped",
    ).length;
    const auditAfter1 = (await kv.list<AuditEntry>(AUDIT_SCOPE)).length;

    const r2 = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_idempotent"] },
    })) as { swept: string[]; checkpointed: string[]; skipped: string[] };
    expect(r2.swept).toHaveLength(0);
    expect(r2.checkpointed).toHaveLength(0);
    expect(r2.skipped).toContain("ses_idempotent");

    const stoppedAfter2 = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::stopped",
    ).length;
    const auditAfter2 = (await kv.list<AuditEntry>(AUDIT_SCOPE)).length;
    expect(stoppedAfter2).toBe(stoppedAfter1);
    expect(auditAfter2).toBe(auditAfter1);
  });
});

describe("Session Sweep - summarize success:false handling", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerSessionSweepFunction(sdk as never, kv as never);
    registerEventTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::slot-reflect", async () => ({ success: true }));
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));
  });

  it("summarize transient failure (empty_provider_response) leaves KV untouched", async () => {
    sdk.registerFunction("mem::summarize", async () => ({
      success: false,
      error: "empty_provider_response",
    }));

    const stale = makeSession({
      id: "ses_transient_fail",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_transient_fail", stale);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_transient_fail"] },
    })) as {
      swept: string[];
      failed: Array<{ sessionId: string; error: string }>;
    };

    expect(result.swept).not.toContain("ses_transient_fail");
    expect(result.failed.map((f) => f.sessionId)).toContain("ses_transient_fail");

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_transient_fail");
    expect(stored?.status).toBe("active");
    expect(stored?.endedAt).toBeUndefined();
    expect(stored?.lastCheckpointAt).toBeUndefined();
  });

  it("summarize permanent no-op (no_provider) advances KV as successful sweep", async () => {
    sdk.registerFunction("mem::summarize", async () => ({
      success: false,
      error: "no_provider",
    }));

    const stale = makeSession({
      id: "ses_no_provider",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_no_provider", stale);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_no_provider"] },
    })) as {
      swept: string[];
      failed: Array<{ sessionId: string; error: string }>;
    };

    expect(result.swept).toContain("ses_no_provider");
    expect(result.failed).toHaveLength(0);

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_no_provider");
    expect(stored?.status).toBe("completed");
    expect(stored?.endedAt).toBeDefined();
    expect(stored?.lastCheckpointAt).toBeDefined();
  });

  it("summarize permanent no-op (no_observations) advances KV as successful sweep", async () => {
    sdk.registerFunction("mem::summarize", async () => ({
      success: false,
      error: "no_observations",
    }));

    const stale = makeSession({
      id: "ses_no_obs",
      startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_no_obs", stale);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: ["ses_no_obs"] },
    })) as {
      swept: string[];
      failed: Array<{ sessionId: string; error: string }>;
    };

    expect(result.swept).toContain("ses_no_obs");
    expect(result.failed).toHaveLength(0);

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_no_obs");
    expect(stored?.status).toBe("completed");
  });
});


describe("Session Sweep - idle-checkpoint mode + finalize decouple", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerSessionSweepFunction(sdk as never, kv as never);
    registerEventTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::summarize", async () => ({ success: true }));
    sdk.registerFunction("mem::slot-reflect", async () => ({ success: true }));
    sdk.registerFunction("mem::graph-extract", async () => ({ success: true }));
  });

  it("finalize writes a summary-only result for an idle-checkpointed-then-abandoned session", async () => {
    const anchor = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    sdk.registerFunction("mem::summarize", async () => {
      const summary: SessionSummary = {
        sessionId: "ses_decouple_noop",
        project: "test-project",
        createdAt: new Date().toISOString(),
        title: "Final summary",
        narrative: "Session finalized after its idle checkpoint.",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 0,
      };
      await kv.set(SUMMARIES_SCOPE, summary.sessionId, summary);
      return { success: true, summary };
    });
    const session = makeSession({
      id: "ses_decouple_noop",
      startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: anchor,
      lastCheckpointAt: anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_decouple_noop", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    })) as { swept: string[]; skipped: string[] };

    expect(result.swept).toContain("ses_decouple_noop");
    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_decouple_noop");
    expect(stored?.status).toBe("completed");
    expect(stored?.endedAt).toBeDefined();
    const stopped = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::stopped",
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0].payload).toMatchObject({
      reason: "sweep-finalize",
      summaryOnly: true,
      waitForCompletion: true,
    });
    expect(sdk.triggerCalls.filter((c) => c.function_id === "mem::summarize")).toHaveLength(1);
    expect(await kv.get<SessionSummary>(SUMMARIES_SCOPE, "ses_decouple_noop")).toMatchObject({
      observationCount: 0,
      title: "Final summary",
    });
  });

  it("finalize consolidates AND marks done when an active session has new activity since last checkpoint", async () => {
    const t1 = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_decouple_delta",
      startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: t2,
      lastCheckpointAt: t1,
    });
    await kv.set(SESSIONS_SCOPE, "ses_decouple_delta", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {},
    })) as { swept: string[] };

    expect(result.swept).toContain("ses_decouple_delta");
    const stopped = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::stopped",
    );
    expect(stopped).toHaveLength(1);
    expect((stopped[0].payload as { sessionId: string }).sessionId).toBe("ses_decouple_delta");
    expect((stopped[0].payload as { until: string }).until).toBe(t2);
    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_decouple_delta");
    expect(stored?.status).toBe("completed");
    expect(stored?.lastCheckpointAt).toBe(t2);
  });

  it("idle-checkpoint mode fires event::session::checkpoint and KEEPS the session active", async () => {
    const anchor = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_idle",
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updatedAt: anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_idle", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { mode: "idle-checkpoint", maxAgeMs: 600000 },
    })) as { swept: string[]; checkpointed: string[] };

    expect(result.checkpointed).toContain("ses_idle");
    expect(result.swept).not.toContain("ses_idle");
    const checkpoint = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::checkpoint",
    );
    expect(checkpoint).toHaveLength(1);
    expect((checkpoint[0].payload as { reason: string }).reason).toBe("idle-checkpoint");
    expect((checkpoint[0].payload as { until: string }).until).toBe(anchor);
    const stopped = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::stopped",
    );
    expect(stopped).toHaveLength(0);
    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_idle");
    expect(stored?.status).toBe("active");
    expect(stored?.endedAt).toBeUndefined();
    expect(stored?.lastCheckpointAt).toBe(anchor);
  });

  it("idle-checkpoint mode is idempotent: a freshly idle-checkpointed session is skipped", async () => {
    const anchor = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_idle_idem",
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updatedAt: anchor,
      lastCheckpointAt: anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_idle_idem", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { mode: "idle-checkpoint", maxAgeMs: 600000 },
    })) as { checkpointed: string[]; skipped: string[] };

    expect(result.checkpointed).not.toContain("ses_idle_idem");
    expect(result.skipped).toContain("ses_idle_idem");
    const checkpoint = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::checkpoint",
    );
    expect(checkpoint).toHaveLength(0);
  });

  it("idle-checkpoint mode skips sessions younger than the idle threshold", async () => {
    const anchor = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_idle_young",
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      updatedAt: anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_idle_young", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { mode: "idle-checkpoint", maxAgeMs: 600000 },
    })) as { checkpointed: string[]; skipped: string[] };

    expect(result.checkpointed).not.toContain("ses_idle_young");
    expect(result.skipped).toContain("ses_idle_young");
    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_idle_young");
    expect(stored?.status).toBe("active");
  });

  it("idle-checkpoint mode ignores completed sessions (active-only)", async () => {
    const anchor = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_idle_completed",
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updatedAt: anchor,
      status: "completed",
      endedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_idle_completed", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { mode: "idle-checkpoint", maxAgeMs: 600000 },
    })) as { swept: string[]; checkpointed: string[] };

    expect(result.checkpointed).not.toContain("ses_idle_completed");
    expect(result.swept).not.toContain("ses_idle_completed");
    const checkpoint = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::checkpoint",
    );
    expect(checkpoint).toHaveLength(0);
  });

  it("idle-checkpoint mode records a session_checkpoint audit", async () => {
    const anchor = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_idle_audit",
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updatedAt: anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_idle_audit", session);

    await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { mode: "idle-checkpoint", maxAgeMs: 600000 },
    });

    const audits = await kv.list<AuditEntry>(AUDIT_SCOPE);
    const cp = audits.filter((e) => e.operation === "session_checkpoint");
    expect(cp.length).toBeGreaterThan(0);
    expect(cp.some((e) => e.targetIds.includes("ses_idle_audit"))).toBe(true);
  });

  it("idle-checkpoint dryRun reports checkpointed without writing KV or firing triggers", async () => {
    const anchor = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_idle_dry",
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updatedAt: anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_idle_dry", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { mode: "idle-checkpoint", maxAgeMs: 600000, dryRun: true },
    })) as { swept: string[]; checkpointed: string[]; dryRun: boolean };

    expect(result.checkpointed).toContain("ses_idle_dry");
    expect(result.swept).not.toContain("ses_idle_dry");
    expect(result.dryRun).toBe(true);
    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_idle_dry");
    expect(stored?.status).toBe("active");
    expect(stored?.lastCheckpointAt).toBeUndefined();
    const checkpoint = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::checkpoint",
    );
    expect(checkpoint).toHaveLength(0);
  });

  it("idle-checkpoint sweep skips summarize, so a crashing summarize cannot fail it", async () => {
    // Idle checkpoints no longer run the full-session summarize (the
    // O(N^2) drain that let the backlog outpace intake); the final
    // summary is deferred to session stop/end, where a summarize crash
    // still routes the session to failed. On the idle path summarize is
    // never reached, so the session is checkpointed regardless.
    let summarizeCalled = false;
    sdk.registerFunction("mem::summarize", async () => {
      summarizeCalled = true;
      throw new Error("simulated pipeline failure");
    });
    const anchor = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const session = makeSession({
      id: "ses_idle_crash",
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updatedAt: anchor,
    });
    await kv.set(SESSIONS_SCOPE, "ses_idle_crash", session);

    const result = (await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { mode: "idle-checkpoint", maxAgeMs: 600000, sessionIds: ["ses_idle_crash"] },
    })) as { checkpointed: string[]; failed: Array<{ sessionId: string; error: string }> };

    expect(summarizeCalled).toBe(false);
    expect(result.failed.map((f) => f.sessionId)).not.toContain("ses_idle_crash");
    expect(result.checkpointed).toContain("ses_idle_crash");
    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_idle_crash");
    expect(stored?.status).toBe("active");
    expect(stored?.lastCheckpointAt).toBe(anchor);
  });
});
