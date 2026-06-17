import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSessionCheckpoint } from "../src/functions/session-checkpoint.js";
import { KV } from "../src/state/schema.js";
import type { Session, AuditEntry } from "../src/types.js";
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

describe("Session Checkpoint Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = mockSdk();
    kv = mockKV();
    registerSessionCheckpoint(sdk as never, kv as never);
  });

  it("queues the first checkpoint for an active session with no prior checkpoint", async () => {
    const session = makeSession({ id: "ses_first" });
    await kv.set(SESSIONS_SCOPE, "ses_first", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_first" },
    })) as { success: boolean; queued?: boolean; lastCheckpointAt?: string; queueDepth?: number | null };

    expect(result.success).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.queueDepth ?? null).toBeNull();
    expect(result.lastCheckpointAt).toBe(session.startedAt);

    const checkpointCall = sdk.triggerCalls.find((c) => c.function_id === "event::session::checkpoint");
    expect(checkpointCall?.payload).toMatchObject({
      sessionId: "ses_first",
      since: undefined,
      until: session.startedAt,
      waitForCompletion: false,
    });

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_first");
    expect(stored?.lastCheckpointAt).toBe(session.startedAt);

    const audits = await kv.list<AuditEntry>(AUDIT_SCOPE);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      operation: "session_checkpoint",
      functionId: "mem::session::checkpoint",
      targetIds: ["ses_first"],
      details: { since: undefined, until: session.startedAt },
    });
  });

  it("returns noOp when the session has no new activity since the last checkpoint", async () => {
    const ts = new Date().toISOString();
    const session = makeSession({
      id: "ses_noop",
      updatedAt: ts,
      lastCheckpointAt: ts,
    });
    await kv.set(SESSIONS_SCOPE, "ses_noop", session);

    const result = (await sdk.trigger({
      function_id: "mem::session::checkpoint",
      payload: { sessionId: "ses_noop" },
    })) as { success: boolean; noOp?: boolean };

    expect(result.success).toBe(true);
    expect(result.noOp).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      "Session checkpoint skipped, no new activity since last checkpoint",
      expect.objectContaining({ sessionId: "ses_noop", anchor: ts, watermark: ts }),
    );
    expect(sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint")).toHaveLength(0);

    const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_noop");
    expect(stored?.lastCheckpointAt).toBe(ts);

    const audits = await kv.list<AuditEntry>(AUDIT_SCOPE);
    expect(audits).toHaveLength(0);
  });

  it("queues a checkpoint after new activity advances updatedAt past the prior checkpoint", async () => {
    const older = new Date(Date.now() - 700_000).toISOString();
    const newer = new Date(Date.now()).toISOString();
    const session = makeSession({
      id: "ses_new",
      updatedAt: newer,
      lastCheckpointAt: older,
    });
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
      since: older,
      until: newer,
      waitForCompletion: false,
    });
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
    const startedAt = new Date(Date.now() - 5_000).toISOString();
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
    const startedAt = new Date(Date.now() - 10_000).toISOString();
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

  describe("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("throttles a checkpoint when called within the debounce window", async () => {
      vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "600000");
      const now = Date.now();
      const lastCheckpointAt = new Date(now - 60_000).toISOString();
      const updatedAt = new Date(now).toISOString();
      const session = makeSession({
        id: "ses_throttle",
        updatedAt,
        lastCheckpointAt,
      });
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
        "Session checkpoint throttled by debounce window",
        expect.objectContaining({ sessionId: "ses_throttle", retryAfterMs: result.retryAfterMs, debounceMs: 600_000 }),
      );

      expect(
        sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint"),
      ).toHaveLength(0);

      const stored = await kv.get<Session>(SESSIONS_SCOPE, "ses_throttle");
      expect(stored?.lastCheckpointAt).toBe(lastCheckpointAt);

      expect(await kv.list<AuditEntry>(AUDIT_SCOPE)).toHaveLength(0);
    });

    it("fires the checkpoint when the debounce window has elapsed", async () => {
      vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "600000");
      const now = Date.now();
      const lastCheckpointAt = new Date(now - 700_000).toISOString();
      const updatedAt = new Date(now).toISOString();
      const session = makeSession({
        id: "ses_window_elapsed",
        updatedAt,
        lastCheckpointAt,
      });
      await kv.set(SESSIONS_SCOPE, "ses_window_elapsed", session);

      const result = (await sdk.trigger({
        function_id: "mem::session::checkpoint",
        payload: { sessionId: "ses_window_elapsed" },
      })) as { success: boolean; queued?: boolean; throttled?: boolean };

      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(result.throttled).toBeUndefined();
      expect(
        sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint"),
      ).toHaveLength(1);
    });

    it("does NOT throttle on first checkpoint when no prior lastCheckpointAt exists", async () => {
      vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "600000");
      const session = makeSession({ id: "ses_first_with_debounce" });
      await kv.set(SESSIONS_SCOPE, "ses_first_with_debounce", session);

      const result = (await sdk.trigger({
        function_id: "mem::session::checkpoint",
        payload: { sessionId: "ses_first_with_debounce" },
      })) as { success: boolean; queued?: boolean; throttled?: boolean };

      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(result.throttled).toBeUndefined();
    });

    it("disables the debounce when AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS=0", async () => {
      vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "0");
      const now = Date.now();
      const lastCheckpointAt = new Date(now - 1_000).toISOString();
      const updatedAt = new Date(now).toISOString();
      const session = makeSession({
        id: "ses_debounce_disabled",
        updatedAt,
        lastCheckpointAt,
      });
      await kv.set(SESSIONS_SCOPE, "ses_debounce_disabled", session);

      const result = (await sdk.trigger({
        function_id: "mem::session::checkpoint",
        payload: { sessionId: "ses_debounce_disabled" },
      })) as { success: boolean; queued?: boolean; throttled?: boolean };

      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(result.throttled).toBeUndefined();
      expect(
        sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint"),
      ).toHaveLength(1);
    });

    it("prefers noOp over throttled when anchor equals watermark", async () => {
      vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "600000");
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
});
