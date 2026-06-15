import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSessionSweepFunction } from "../src/functions/session-sweep.js";
import type { Session, AuditEntry } from "../src/types.js";

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
const AUDIT_SCOPE = "mem:audit";

describe("Session Sweep Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerSessionSweepFunction(sdk as never, kv as never);
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

  it("ignores sessions whose status is not active", async () => {
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
    })) as { swept: string[]; skipped: string[]; totalActive: number };

    expect(result.swept).not.toContain("ses_done");
    expect(result.skipped).not.toContain("ses_done");
    expect(result.totalActive).toBe(0);

    const stoppedTriggers = sdk.triggerCalls.filter(
      (c) => c.function_id === "event::session::stopped",
    );
    expect(stoppedTriggers).toHaveLength(0);
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
