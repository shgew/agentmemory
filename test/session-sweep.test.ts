import { describe, it, expect, beforeEach, vi } from "vitest";

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
  isAutoCompressEnabled: () => false,
}));

import { registerSessionSweepFunction } from "../src/functions/session-sweep.js";
import type { Session, AuditEntry } from "../src/types.js";
import { registerEventTriggers } from "../src/triggers/events.js";

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
