import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSessionCheckpoint } from "../src/functions/session-checkpoint.js";
import { registerSessionSweepFunction } from "../src/functions/session-sweep.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { KV } from "../src/state/schema.js";
import type {
  Session,
  AuditEntry,
  CompressedObservation,
  RawObservation,
} from "../src/types.js";
import { logger } from "../src/logger.js";

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
};

function mockSdk() {
  const triggerCalls: MockTriggerCall[] = [];
  const functions = new Map<string, (data: unknown) => unknown | Promise<unknown>>();
  const sdk = {
    triggerCalls,
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: (data: unknown) => unknown | Promise<unknown>,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) => {
      triggerCalls.push({
        function_id: input.function_id,
        payload: input.payload,
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

const SESSIONS_SCOPE = KV.sessions;
const AUDIT_SCOPE = KV.audit;

const IDLE_THRESHOLD_MS = 600_000;
const pastThreshold = (): string =>
  new Date(Date.now() - IDLE_THRESHOLD_MS - 100_000).toISOString();

describe("Session Checkpoint Function (trailing-edge idle gate)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", String(IDLE_THRESHOLD_MS));
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "");
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
    sdk = mockSdk();
    kv = mockKV();
    registerSessionCheckpoint(sdk as never, kv as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fires a checkpoint for a session idle past the threshold with no prior checkpoint", async () => {
    const startedAt = pastThreshold();
    const session = makeSession({ id: "ses_first", startedAt });
    await kv.set(SESSIONS_SCOPE, "ses_first", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_first" },
    })) as { success: boolean; queued?: boolean; lastCheckpointAt?: string; queueDepth?: number | null };

    expect(result.success).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.lastCheckpointAt).toBe(startedAt);

    const checkpointCall = sdk.triggerCalls.find((c) => c.function_id === "event::session::checkpoint");
    expect(checkpointCall?.payload).toMatchObject({
      sessionId: "ses_first",
      reason: "idle-checkpoint",
      since: undefined,
      until: startedAt,
      waitForCompletion: true,
    });

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_first");
    expect(stored?.lastCheckpointAt).toBe(startedAt);

    const audits = await kv.list<AuditEntry>(AUDIT_SCOPE);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      operation: "session_checkpoint",
      functionId: "mem::session::checkpoint",
      targetIds: ["ses_first"],
      details: { since: undefined, until: startedAt },
    });
  });

  it("defers without firing (no free first-fire) when a fresh session is idle below the threshold", async () => {
    const session = makeSession({ id: "ses_fresh", startedAt: new Date().toISOString() });
    await kv.set(SESSIONS_SCOPE, "ses_fresh", session);
    const list = vi.spyOn(kv, "list");

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_fresh" },
    })) as { success: boolean; throttled?: boolean; retryAfterMs?: number; queued?: boolean };

    expect(result.success).toBe(true);
    expect(result.throttled).toBe(true);
    expect(result.queued).toBeUndefined();
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(IDLE_THRESHOLD_MS);
    expect(logger.info).toHaveBeenCalledWith(
      "Session checkpoint deferred by idle window",
      expect.objectContaining({ sessionId: "ses_fresh", idleThresholdMs: IDLE_THRESHOLD_MS }),
    );
    expect(sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint")).toHaveLength(0);
    expect(list).not.toHaveBeenCalledWith(KV.rawPayloads);

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_fresh");
    expect(stored?.lastCheckpointAt).toBeUndefined();
    expect(await kv.list<AuditEntry>(AUDIT_SCOPE)).toHaveLength(0);
  });

  it("returns noOp (before the idle gate) when there is no new activity since the last checkpoint", async () => {
    const ts = pastThreshold();
    const session = makeSession({ id: "ses_noop", updatedAt: ts, lastCheckpointAt: ts });
    await kv.set(SESSIONS_SCOPE, "ses_noop", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_noop" },
    })) as { success: boolean; noOp?: boolean; throttled?: boolean };

    expect(result.success).toBe(true);
    expect(result.noOp).toBe(true);
    expect(result.throttled).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      "Session checkpoint skipped, no new activity since last checkpoint",
      expect.objectContaining({ sessionId: "ses_noop", anchor: ts, watermark: ts }),
    );
    expect(sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint")).toHaveLength(0);

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_noop");
    expect(stored?.lastCheckpointAt).toBe(ts);
    expect(await kv.list<AuditEntry>(AUDIT_SCOPE)).toHaveLength(0);
  });

  it("fires when new activity exists AND idle exceeds the threshold", async () => {
    const older = new Date(Date.now() - IDLE_THRESHOLD_MS - 800_000).toISOString();
    const newer = pastThreshold();
    const session = makeSession({ id: "ses_new", updatedAt: newer, lastCheckpointAt: older });
    await kv.set(SESSIONS_SCOPE, "ses_new", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_new" },
    })) as { success: boolean; queued?: boolean; lastCheckpointAt?: string };

    expect(result.success).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.lastCheckpointAt).toBe(newer);
    expect(logger.info).toHaveBeenCalledWith(
      "Session checkpoint fired consolidation",
      expect.objectContaining({ sessionId: "ses_new", since: older, until: newer }),
    );

    const checkpointCall = sdk.triggerCalls.find((c) => c.function_id === "event::session::checkpoint");
    expect(checkpointCall?.payload).toMatchObject({
      sessionId: "ses_new",
      reason: "idle-checkpoint",
      since: older,
      until: newer,
      waitForCompletion: true,
    });
  });

  it("leaves the watermark unchanged when consolidation returns a failure", async () => {
    const startedAt = pastThreshold();
    const session = makeSession({ id: "ses_failed", startedAt });
    await kv.set(SESSIONS_SCOPE, "ses_failed", session);
    sdk.registerFunction("event::session::checkpoint", async () => ({
      success: false,
      error: "graph_failed",
    }));

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_failed" },
    })) as { success: boolean; error?: string };

    expect(result).toEqual({
      success: false,
      error: "consolidation_failed",
    });
    expect(
      (await kv.get<Session>(SESSIONS_SCOPE, "ses_failed"))
        ?.lastCheckpointAt,
    ).toBeUndefined();
    expect(await kv.list<AuditEntry>(AUDIT_SCOPE)).toHaveLength(0);
  });

  it("leaves the watermark unchanged when consolidation throws", async () => {
    const startedAt = pastThreshold();
    const session = makeSession({ id: "ses_thrown", startedAt });
    await kv.set(SESSIONS_SCOPE, session.id, session);
    sdk.registerFunction("event::session::checkpoint", async () => {
      throw new Error("provider failed");
    });

    const result = await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: session.id },
    });

    expect(result).toEqual({
      success: false,
      error: "consolidation_failed",
    });
    expect(
      (await kv.get<Session>(SESSIONS_SCOPE, session.id))?.lastCheckpointAt,
    ).toBeUndefined();
    expect(await kv.list<AuditEntry>(AUDIT_SCOPE)).toHaveLength(0);
  });

  it("retries pending compression before advancing the watermark", async () => {
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "true");
    const startedAt = pastThreshold();
    const sessionId = "ses_pending";
    const session = makeSession({
      id: sessionId,
      startedAt,
      lastCheckpointAt: startedAt,
    });
    const observationTimestamp = new Date(
      new Date(startedAt).getTime() + 1_000,
    ).toISOString();
    const raw: RawObservation = {
      id: "obs_pending",
      sessionId,
      timestamp: observationTimestamp,
      hookType: "prompt_submit",
      raw: { prompt: "retain this" },
      userPrompt: "retain this",
    };
    await kv.set(SESSIONS_SCOPE, sessionId, session);
    await kv.set(KV.rawPayloads, raw.id, raw);
    await kv.set(KV.pendingCompression(sessionId), raw.id, {
      id: raw.id,
      sessionId,
    });

    let shouldFail = true;
    let compressCalls = 0;
    sdk.registerFunction("mem::compress", async () => {
      compressCalls += 1;
      if (shouldFail) return { success: false, error: "temporary_failure" };
      const compressed: CompressedObservation = {
        id: raw.id,
        sessionId,
        timestamp: observationTimestamp,
        sourceType: raw.hookType,
        type: "conversation",
        title: "Recovered observation",
        facts: [],
        narrative: "retain this",
        concepts: [],
        files: [],
        importance: 5,
      };
      await kv.set(KV.observations(sessionId), raw.id, compressed);
      return { success: true };
    });

    const failed = await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId },
    });
    expect(failed).toEqual({
      success: false,
      error: "consolidation_failed",
    });
    expect(
      (await kv.get<Session>(SESSIONS_SCOPE, sessionId))?.lastCheckpointAt,
    ).toBe(startedAt);
    expect(
      sdk.triggerCalls.filter(
        (call) => call.function_id === "event::session::checkpoint",
      ),
    ).toHaveLength(0);
    expect(await kv.list<AuditEntry>(AUDIT_SCOPE)).toHaveLength(0);

    shouldFail = false;
    const recovered = await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId },
    });
    expect(recovered).toMatchObject({
      success: true,
      lastCheckpointAt: startedAt,
    });
    expect(
      sdk.triggerCalls.filter(
        (call) => call.function_id === "event::session::checkpoint",
      ),
    ).toContainEqual({
      function_id: "event::session::checkpoint",
      payload: {
        sessionId,
        reason: "idle-checkpoint",
        since: undefined,
        until: undefined,
        waitForCompletion: true,
        pendingCompressionDrained: true,
        pendingCompressionRecovered: true,
      },
    });
    expect(compressCalls).toBe(2);

    await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId },
    });
    expect(compressCalls).toBe(2);
  });

  it("allows observations while pending compression is blocked", async () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "0");
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "true");
    registerObserveFunction(sdk as never, kv as never);

    const checkpointAt = pastThreshold();
    const sessionId = "ses_blocked_compression";
    const raw: RawObservation = {
      id: "obs_blocked_compression",
      sessionId,
      timestamp: checkpointAt,
      hookType: "prompt_submit",
      raw: { prompt: "pending before checkpoint" },
      userPrompt: "pending before checkpoint",
    };
    await kv.set(
      SESSIONS_SCOPE,
      sessionId,
      makeSession({ id: sessionId, updatedAt: checkpointAt }),
    );
    await kv.set(KV.rawPayloads, raw.id, raw);
    await kv.set(KV.pendingCompression(sessionId), raw.id, {
      id: raw.id,
      sessionId,
    });

    let markCompressionStarted: () => void = () => {};
    const compressionStarted = new Promise<void>((resolve) => {
      markCompressionStarted = resolve;
    });
    let finishCompression: () => void = () => {};
    const compressionFinished = new Promise<void>((resolve) => {
      finishCompression = resolve;
    });
    sdk.registerFunction("mem::compress", async (payload) => {
      const observationId = (payload as { observationId: string }).observationId;
      if (observationId === raw.id) {
        markCompressionStarted();
        await compressionFinished;
      }
      const compressed: CompressedObservation = {
        id: observationId,
        sessionId,
        timestamp:
          observationId === raw.id ? raw.timestamp : new Date().toISOString(),
        sourceType: raw.hookType,
        type: "conversation",
        title: "Recovered pending observation",
        facts: [],
        narrative: "pending before checkpoint",
        concepts: [],
        files: [],
        importance: 5,
      };
      await kv.set(KV.observations(sessionId), observationId, compressed);
      return { success: true };
    });

    const checkpoint = sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId },
    });
    await compressionStarted;

    const observation = sdk.trigger({
      function_id: "mem::observe",
      payload: {
        sessionId,
        project: "test-project",
        cwd: "/workspace",
        hookType: "prompt_submit",
        timestamp: new Date().toISOString(),
        data: { prompt: "captured while compression waits" },
      },
    });
    let observationTimeout: ReturnType<typeof setTimeout> | undefined;
    const observationCompletedBeforeCompression = await Promise.race([
      observation.then(
        () => {
          if (observationTimeout) clearTimeout(observationTimeout);
          return true;
        },
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        observationTimeout = setTimeout(() => resolve(false), 250);
      }),
    ]);
    const anchorBeforeCompressionFinished = (
      await kv.get<Session>(SESSIONS_SCOPE, sessionId)
    )?.updatedAt;

    finishCompression();
    await checkpoint;
    await observation;

    expect(observationCompletedBeforeCompression).toBe(true);
    expect(anchorBeforeCompressionFinished).not.toBe(checkpointAt);
    expect(
      (await kv.get<Session>(SESSIONS_SCOPE, sessionId))?.lastCheckpointAt,
    ).toBe(anchorBeforeCompressionFinished);
  });

  it("defers when there is new activity but idle is below the threshold (no per-turn fire)", async () => {
    const older = pastThreshold();
    const newer = new Date().toISOString();
    const session = makeSession({ id: "ses_recent_activity", updatedAt: newer, lastCheckpointAt: older });
    await kv.set(SESSIONS_SCOPE, "ses_recent_activity", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_recent_activity" },
    })) as { success: boolean; throttled?: boolean; queued?: boolean };

    expect(result.success).toBe(true);
    expect(result.throttled).toBe(true);
    expect(result.queued).toBeUndefined();
    expect(sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint")).toHaveLength(0);

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_recent_activity");
    expect(stored?.lastCheckpointAt).toBe(older);
  });

  it("returns session_not_found when the session is missing", async () => {
    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "missing" },
    })) as { success: boolean; error?: string };

    expect(result).toEqual({ success: false, error: "session_not_found" });
    expect(sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint")).toHaveLength(0);
    expect(await kv.list<AuditEntry>(AUDIT_SCOPE)).toHaveLength(0);
  });

  it("returns session_not_active when the session is completed", async () => {
    const session = makeSession({
      id: "ses_done",
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    await kv.set(SESSIONS_SCOPE, "ses_done", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_done" },
    })) as { success: boolean; error?: string };

    expect(result).toEqual({ success: false, error: "session_not_active" });
    expect(sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint")).toHaveLength(0);
    expect(await kv.list<AuditEntry>(AUDIT_SCOPE)).toHaveLength(0);
  });

  it("uses startedAt as the anchor when updatedAt is missing", async () => {
    const startedAt = pastThreshold();
    const session = makeSession({
      id: "ses_anchor",
      startedAt,
      updatedAt: undefined,
    });
    await kv.set(SESSIONS_SCOPE, "ses_anchor", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_anchor" },
    })) as { success: boolean; queued?: boolean; lastCheckpointAt?: string };

    expect(result.success).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.lastCheckpointAt).toBe(startedAt);
  });

  it("serializes concurrent calls so the checkpoint trigger runs only once", async () => {
    const startedAt = pastThreshold();
    const session = makeSession({ id: "ses_lock", startedAt });
    await kv.set(SESSIONS_SCOPE, "ses_lock", session);

    const [first, second] = await Promise.all([
      sdk.trigger({
        function_id: "mem::session::checkpoint",
        payload: { sessionId: "ses_lock" },
      }),
      sdk.trigger({
        function_id: "mem::session::checkpoint",
        payload: { sessionId: "ses_lock" },
      }),
    ]);

    expect([first, second].some((result) => (result as { queued?: boolean }).queued)).toBe(true);
    expect([first, second].some((result) => (result as { noOp?: boolean }).noOp)).toBe(true);
    expect(sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint")).toHaveLength(1);
  });

  it("serializes with idle sweep so the same activity window runs once", async () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "0");
    registerSessionSweepFunction(sdk as never, kv as never);
    const checkpointAt = pastThreshold();
    const sessionId = "ses_sweep_checkpoint_lock";
    await kv.set(
      SESSIONS_SCOPE,
      sessionId,
      makeSession({ id: sessionId, updatedAt: checkpointAt }),
    );

    const firstCheckpointStarted = deferred();
    const releaseFirstCheckpoint = deferred();
    let checkpointCalls = 0;
    sdk.registerFunction("event::session::checkpoint", async () => {
      checkpointCalls += 1;
      if (checkpointCalls === 1) {
        firstCheckpointStarted.resolve();
        await releaseFirstCheckpoint.promise;
      }
      return { success: true };
    });

    const sweep = sdk.trigger({
      function_id: "mem::session-sweep",
      payload: {
        sessionIds: [sessionId],
        mode: "idle-checkpoint",
        maxAgeMs: 1,
      },
    });
    await firstCheckpointStarted.promise;

    const reactiveCheckpoint = sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(checkpointCalls).toBe(1);

    releaseFirstCheckpoint.resolve();
    const [sweepResult, checkpointResult] = await Promise.all([
      sweep,
      reactiveCheckpoint,
    ]);

    expect(
      (sweepResult as { checkpointed: string[] }).checkpointed,
    ).toContain(sessionId);
    expect(checkpointResult).toMatchObject({ success: true, noOp: true });
    expect(checkpointCalls).toBe(1);
  });

  it("invalidates the pending-compression drain when activity changes", async () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "0");
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "true");
    registerObserveFunction(sdk as never, kv as never);

    const checkpointAt = pastThreshold();
    const sessionId = "ses_drain_anchor";
    await kv.set(
      SESSIONS_SCOPE,
      sessionId,
      makeSession({ id: sessionId, updatedAt: checkpointAt }),
    );

    const rawListRead = deferred();
    const releaseRawList = deferred();
    const originalList = kv.list;
    let blockedRawList = false;
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.pendingCompression(sessionId) && !blockedRawList) {
        blockedRawList = true;
        const snapshot = await originalList<T>(scope);
        rawListRead.resolve();
        await releaseRawList.promise;
        return snapshot;
      }
      return originalList<T>(scope);
    }) as typeof kv.list;

    let checkpointPayload:
      | {
          until?: string;
          pendingCompressionDrained?: boolean;
        }
      | undefined;
    sdk.registerFunction("event::session::checkpoint", async (payload) => {
      checkpointPayload = payload as typeof checkpointPayload;
      return { success: true };
    });

    const checkpoint = sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId },
    });
    await rawListRead.promise;

    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        sessionId,
        project: "test-project",
        cwd: "/workspace",
        hookType: "prompt_submit",
        timestamp: new Date().toISOString(),
        data: { prompt: "arrived during pending compression drain" },
      },
    });
    const observed = await kv.get<Session>(SESSIONS_SCOPE, sessionId);
    releaseRawList.resolve();
    await checkpoint;

    expect(observed?.updatedAt).not.toBe(checkpointAt);
    expect(checkpointPayload).toMatchObject({
      until: observed?.updatedAt,
      pendingCompressionDrained: false,
    });
  });

  it("allows observations during consolidation without advancing past them", async () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "0");
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
    registerObserveFunction(sdk as never, kv as never);

    const checkpointAt = pastThreshold();
    const sessionId = "ses_live_consolidation";
    await kv.set(
      SESSIONS_SCOPE,
      sessionId,
      makeSession({ id: sessionId, updatedAt: checkpointAt }),
    );

    let markConsolidationStarted: () => void = () => {};
    const consolidationStarted = new Promise<void>((resolve) => {
      markConsolidationStarted = resolve;
    });
    let finishConsolidation: () => void = () => {};
    const consolidationFinished = new Promise<void>((resolve) => {
      finishConsolidation = resolve;
    });
    sdk.registerFunction("event::session::checkpoint", async () => {
      markConsolidationStarted();
      await consolidationFinished;
      return { success: true };
    });

    const checkpoint = sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId },
    });
    await consolidationStarted;

    const observation = sdk.trigger({
      function_id: "mem::observe",
      payload: {
        sessionId,
        project: "test-project",
        cwd: "/workspace",
        hookType: "prompt_submit",
        timestamp: new Date().toISOString(),
        data: { prompt: "captured during consolidation" },
      },
    });
    let observationTimeout: ReturnType<typeof setTimeout> | undefined;
    const observationCompletedBeforeConsolidation = await Promise.race([
      observation.then(() => {
        if (observationTimeout) clearTimeout(observationTimeout);
        return true;
      }),
      new Promise<boolean>((resolve) => {
        observationTimeout = setTimeout(() => resolve(false), 250);
      }),
    ]);

    finishConsolidation();
    await checkpoint;
    await observation;

    expect(observationCompletedBeforeConsolidation).toBe(true);
    const afterFirstCheckpoint = await kv.get<Session>(
      SESSIONS_SCOPE,
      sessionId,
    );
    expect(afterFirstCheckpoint?.lastCheckpointAt).toBe(checkpointAt);
    expect(afterFirstCheckpoint?.updatedAt).not.toBe(checkpointAt);

    await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId },
    });
    const checkpointCalls = sdk.triggerCalls.filter(
      (call) => call.function_id === "event::session::checkpoint",
    );
    expect(checkpointCalls).toHaveLength(2);
    expect(checkpointCalls[1]?.payload).toMatchObject({
      sessionId,
      since: checkpointAt,
      until: afterFirstCheckpoint?.updatedAt,
      waitForCompletion: true,
    });
  });
});

describe("Session checkpoint idle-threshold env resolution", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = mockSdk();
    kv = mockKV();
    registerSessionCheckpoint(sdk as never, kv as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defers when idle is below the AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS alias window", async () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "600000");
    const lastCheckpointAt = new Date(Date.now() - 60_000).toISOString();
    const updatedAt = new Date().toISOString();
    const session = makeSession({ id: "ses_throttle", updatedAt, lastCheckpointAt });
    await kv.set(SESSIONS_SCOPE, "ses_throttle", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_throttle" },
    })) as { success: boolean; throttled?: boolean; retryAfterMs?: number };

    expect(result.success).toBe(true);
    expect(result.throttled).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(600_000);
    expect(logger.info).toHaveBeenCalledWith(
      "Session checkpoint deferred by idle window",
      expect.objectContaining({ sessionId: "ses_throttle", idleThresholdMs: 600_000 }),
    );
    expect(
      sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint"),
    ).toHaveLength(0);

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_throttle");
    expect(stored?.lastCheckpointAt).toBe(lastCheckpointAt);
    expect(await kv.list<AuditEntry>(AUDIT_SCOPE)).toHaveLength(0);
  });

  it("fires when idle exceeds the alias window", async () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "600000");
    const lastCheckpointAt = new Date(Date.now() - 1_400_000).toISOString();
    const updatedAt = new Date(Date.now() - 700_000).toISOString();
    const session = makeSession({ id: "ses_elapsed", updatedAt, lastCheckpointAt });
    await kv.set(SESSIONS_SCOPE, "ses_elapsed", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_elapsed" },
    })) as { success: boolean; queued?: boolean; throttled?: boolean };

    expect(result.success).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.throttled).toBeUndefined();
    expect(
      sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint"),
    ).toHaveLength(1);
  });

  it("does NOT free-fire a fresh session under the alias window", async () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "600000");
    const session = makeSession({ id: "ses_first_alias", startedAt: new Date().toISOString() });
    await kv.set(SESSIONS_SCOPE, "ses_first_alias", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_first_alias" },
    })) as { success: boolean; queued?: boolean; throttled?: boolean };

    expect(result.success).toBe(true);
    expect(result.throttled).toBe(true);
    expect(result.queued).toBeUndefined();
    expect(
      sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint"),
    ).toHaveLength(0);
  });

  it("disables the gate (eager fire) when the threshold is 0", async () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "0");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "");
    const lastCheckpointAt = new Date(Date.now() - 1_000).toISOString();
    const updatedAt = new Date().toISOString();
    const session = makeSession({ id: "ses_eager", updatedAt, lastCheckpointAt });
    await kv.set(SESSIONS_SCOPE, "ses_eager", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_eager" },
    })) as { success: boolean; queued?: boolean; throttled?: boolean };

    expect(result.success).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.throttled).toBeUndefined();
    expect(
      sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint"),
    ).toHaveLength(1);
  });

  it("AGENTMEMORY_IDLE_CHECKPOINT_MS overrides the debounce alias", async () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "0");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "600000");
    const lastCheckpointAt = new Date(Date.now() - 1_000).toISOString();
    const updatedAt = new Date().toISOString();
    const session = makeSession({ id: "ses_precedence", updatedAt, lastCheckpointAt });
    await kv.set(SESSIONS_SCOPE, "ses_precedence", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_precedence" },
    })) as { success: boolean; queued?: boolean; throttled?: boolean };

    expect(result.success).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.throttled).toBeUndefined();
    expect(
      sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint"),
    ).toHaveLength(1);
  });

  it("prefers noOp over deferred when anchor equals watermark", async () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "600000");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "");
    const ts = new Date(Date.now() - 60_000).toISOString();
    const session = makeSession({
      id: "ses_noop_over_throttle",
      updatedAt: ts,
      lastCheckpointAt: ts,
    });
    await kv.set(SESSIONS_SCOPE, "ses_noop_over_throttle", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_noop_over_throttle" },
    })) as { success: boolean; noOp?: boolean; throttled?: boolean };

    expect(result.success).toBe(true);
    expect(result.noOp).toBe(true);
    expect(result.throttled).toBeUndefined();
  });
});
