#!/usr/bin/env tsx
import { registerSessionSweepFunction } from "../src/functions/session-sweep.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import type { Session, AuditEntry, CompressedObservation } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
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
}

type TriggerCall = { function_id: string; payload: unknown };

function mockSdk() {
  const triggerCalls: TriggerCall[] = [];
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
    trigger: async (input: { function_id: string; payload?: unknown; action?: unknown }) => {
      triggerCalls.push({ function_id: input.function_id, payload: input.payload });
      const fn = functions.get(input.function_id);
      if (!fn) return {};
      return fn(input.payload);
    },
  };
  return sdk;
}

function setupWorld() {
  const sdk = mockSdk();
  const kv = mockKV();
  sdk.registerFunction("mem::summarize", async () => ({ success: true }));
  sdk.registerFunction("mem::slot-reflect", async () => ({ success: true, applied: 0 }));
  sdk.registerFunction("mem::graph-extract", async () => ({ success: true, nodesAdded: 0, edgesAdded: 0 }));
  registerEventTriggers(sdk as never, kv as never);
  registerSessionSweepFunction(sdk as never, kv as never);
  return { sdk, kv };
}

async function getSession(kv: ReturnType<typeof mockKV>, sessionId: string): Promise<Session | null> {
  return kv.get<Session>("mem:sessions", sessionId);
}

async function simulatePostCompletionActivity(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
  newUpdatedAt: string,
) {
  const current = await getSession(kv, sessionId);
  if (!current) throw new Error(`Session ${sessionId} not found for simulated activity`);
  await kv.update("mem:sessions", sessionId, [
    { type: "set", path: "updatedAt", value: newUpdatedAt },
    { type: "set", path: "observationCount", value: (current.observationCount ?? 0) + 1 },
  ]);
  const obsId = `obs_post_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const obs: CompressedObservation = {
    id: obsId,
    sessionId,
    timestamp: newUpdatedAt,
    type: "conversation",
    title: `post-completion activity at ${newUpdatedAt}`,
    facts: [],
    narrative: "",
    concepts: [],
    files: [],
    importance: 5,
  };
  await kv.set(`mem:obs:${sessionId}`, obsId, obs);
}

const HOUR_MS = 60 * 60 * 1000;
const SEVEN_HOURS_MS = 7 * HOUR_MS;
const EIGHT_HOURS_MS = 8 * HOUR_MS;

interface ScenarioReport {
  name: string;
  passed: boolean;
  details: string[];
}

async function scenarioS1(): Promise<ScenarioReport> {
  const name = "S1 walk-away";
  const details: string[] = [];
  const { sdk, kv } = setupWorld();
  const now = Date.now();
  const initialUpdatedAt = new Date(now - EIGHT_HOURS_MS).toISOString();
  const sessionId = "ses_S1_walk_away";

  await kv.set("mem:sessions", sessionId, {
    id: sessionId,
    project: "smoke",
    cwd: "/tmp",
    startedAt: initialUpdatedAt,
    updatedAt: initialUpdatedAt,
    status: "active",
    observationCount: 1,
  } satisfies Session);

  const sweep1 = (await sdk.trigger({
    function_id: "mem::session-sweep",
    payload: { sessionIds: [sessionId] },
  })) as { swept: string[]; checkpointed: string[]; skipped: string[] };

  const sessionAfter1 = await getSession(kv, sessionId);
  if (!sessionAfter1) {
    details.push("FAIL: session missing after sweep1");
    return { name, passed: false, details };
  }
  if (!sweep1.swept.includes(sessionId)) {
    details.push(`FAIL: sweep1.swept did not include ${sessionId}: ${JSON.stringify(sweep1)}`);
    return { name, passed: false, details };
  }
  if (sweep1.checkpointed.length !== 0) {
    details.push(`FAIL: sweep1.checkpointed expected empty, got ${JSON.stringify(sweep1.checkpointed)}`);
    return { name, passed: false, details };
  }
  if (sessionAfter1.status !== "completed") {
    details.push(`FAIL: status expected completed, got ${sessionAfter1.status}`);
    return { name, passed: false, details };
  }
  if (sessionAfter1.lastCheckpointAt !== initialUpdatedAt) {
    details.push(
      `FAIL: lastCheckpointAt expected ${initialUpdatedAt}, got ${sessionAfter1.lastCheckpointAt}`,
    );
    return { name, passed: false, details };
  }

  const sweep2 = (await sdk.trigger({
    function_id: "mem::session-sweep",
    payload: { sessionIds: [sessionId] },
  })) as { swept: string[]; checkpointed: string[]; skipped: string[] };

  if (sweep2.swept.length !== 0 || sweep2.checkpointed.length !== 0) {
    details.push(
      `FAIL: sweep2 expected empty swept and checkpointed, got swept=${JSON.stringify(sweep2.swept)} checkpointed=${JSON.stringify(sweep2.checkpointed)}`,
    );
    return { name, passed: false, details };
  }
  if (!sweep2.skipped.includes(sessionId)) {
    details.push(`FAIL: sweep2.skipped expected ${sessionId}, got ${JSON.stringify(sweep2.skipped)}`);
    return { name, passed: false, details };
  }

  const stoppedTriggers = sdk.triggerCalls.filter((c) => c.function_id === "event::session::stopped");
  const checkpointTriggers = sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint");
  if (stoppedTriggers.length !== 1) {
    details.push(`FAIL: expected exactly 1 stopped trigger, got ${stoppedTriggers.length}`);
    return { name, passed: false, details };
  }
  if (checkpointTriggers.length !== 0) {
    details.push(`FAIL: expected 0 checkpoint triggers, got ${checkpointTriggers.length}`);
    return { name, passed: false, details };
  }

  const audits = (await kv.list<AuditEntry>("mem:audit")).filter(
    (e) => e.functionId === "mem::session-sweep",
  );
  if (audits.length !== 1) {
    details.push(`FAIL: expected exactly 1 audit entry, got ${audits.length}`);
    return { name, passed: false, details };
  }
  if (audits[0].operation !== "session_sweep") {
    details.push(`FAIL: audit operation expected session_sweep, got ${audits[0].operation}`);
    return { name, passed: false, details };
  }

  details.push(`pass: status=completed, lastCheckpointAt=${sessionAfter1.lastCheckpointAt}`);
  details.push(`pass: sweep2 skipped the session, no new triggers`);
  details.push(`pass: 1 stopped trigger, 0 checkpoint triggers, 1 session_sweep audit`);
  return { name, passed: true, details };
}

async function scenarioS2(): Promise<ScenarioReport> {
  const name = "S2 single resume";
  const details: string[] = [];
  const { sdk, kv } = setupWorld();
  const now = Date.now();
  const initialUpdatedAt = new Date(now - EIGHT_HOURS_MS).toISOString();
  const resumeUpdatedAt = new Date(now - SEVEN_HOURS_MS).toISOString();
  const sessionId = "ses_S2_resume";

  await kv.set("mem:sessions", sessionId, {
    id: sessionId,
    project: "smoke",
    cwd: "/tmp",
    startedAt: initialUpdatedAt,
    updatedAt: initialUpdatedAt,
    status: "active",
    observationCount: 1,
  } satisfies Session);

  await sdk.trigger({
    function_id: "mem::session-sweep",
    payload: { sessionIds: [sessionId] },
  });
  const sessionAfterClose = await getSession(kv, sessionId);
  if (!sessionAfterClose) {
    details.push("FAIL: session missing after close");
    return { name, passed: false, details };
  }
  const lastCheckpointAt1 = sessionAfterClose.lastCheckpointAt;
  if (lastCheckpointAt1 !== initialUpdatedAt) {
    details.push(`FAIL: lastCheckpointAt1 expected ${initialUpdatedAt}, got ${lastCheckpointAt1}`);
    return { name, passed: false, details };
  }
  const endedAtAfterClose = sessionAfterClose.endedAt;

  await simulatePostCompletionActivity(kv, sessionId, resumeUpdatedAt);

  const sweep2 = (await sdk.trigger({
    function_id: "mem::session-sweep",
    payload: { sessionIds: [sessionId] },
  })) as { swept: string[]; checkpointed: string[]; skipped: string[] };

  const sessionAfter2 = await getSession(kv, sessionId);
  if (!sessionAfter2) {
    details.push("FAIL: session missing after sweep2");
    return { name, passed: false, details };
  }
  if (!sweep2.checkpointed.includes(sessionId)) {
    details.push(`FAIL: sweep2.checkpointed expected ${sessionId}, got ${JSON.stringify(sweep2.checkpointed)}`);
    return { name, passed: false, details };
  }
  if (sweep2.swept.length !== 0) {
    details.push(`FAIL: sweep2.swept expected empty, got ${JSON.stringify(sweep2.swept)}`);
    return { name, passed: false, details };
  }
  if (sessionAfter2.status !== "completed") {
    details.push(`FAIL: status should stay completed, got ${sessionAfter2.status}`);
    return { name, passed: false, details };
  }
  if (sessionAfter2.endedAt !== endedAtAfterClose) {
    details.push(
      `FAIL: endedAt should be unchanged across checkpoint, got ${sessionAfter2.endedAt}, expected ${endedAtAfterClose}`,
    );
    return { name, passed: false, details };
  }
  if (sessionAfter2.lastCheckpointAt !== resumeUpdatedAt) {
    details.push(
      `FAIL: lastCheckpointAt2 expected ${resumeUpdatedAt}, got ${sessionAfter2.lastCheckpointAt}`,
    );
    return { name, passed: false, details };
  }

  const stoppedTriggers = sdk.triggerCalls.filter((c) => c.function_id === "event::session::stopped");
  const checkpointTriggers = sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint");
  if (stoppedTriggers.length !== 1) {
    details.push(`FAIL: expected exactly 1 stopped trigger, got ${stoppedTriggers.length}`);
    return { name, passed: false, details };
  }
  if (checkpointTriggers.length !== 1) {
    details.push(`FAIL: expected exactly 1 checkpoint trigger, got ${checkpointTriggers.length}`);
    return { name, passed: false, details };
  }
  const checkpointPayload = checkpointTriggers[0].payload as { since?: string; until?: string };
  if (checkpointPayload.since !== initialUpdatedAt) {
    details.push(
      `FAIL: checkpoint.since expected ${initialUpdatedAt}, got ${checkpointPayload.since}`,
    );
    return { name, passed: false, details };
  }
  if (checkpointPayload.until !== resumeUpdatedAt) {
    details.push(
      `FAIL: checkpoint.until expected ${resumeUpdatedAt}, got ${checkpointPayload.until}`,
    );
    return { name, passed: false, details };
  }

  details.push(
    `pass: status stayed completed, endedAt unchanged at ${endedAtAfterClose}, lastCheckpointAt advanced from ${initialUpdatedAt} to ${resumeUpdatedAt}`,
  );
  details.push(`pass: 1 stopped + 1 checkpoint trigger, checkpoint window ${initialUpdatedAt} -> ${resumeUpdatedAt}`);
  return { name, passed: true, details };
}

async function scenarioS3(): Promise<ScenarioReport> {
  const name = "S3 multi-night resume";
  const details: string[] = [];
  const { sdk, kv } = setupWorld();
  const now = Date.now();
  const baseAnchor = new Date(now - 24 * HOUR_MS).toISOString();
  const sessionId = "ses_S3_multi";

  await kv.set("mem:sessions", sessionId, {
    id: sessionId,
    project: "smoke",
    cwd: "/tmp",
    startedAt: baseAnchor,
    updatedAt: baseAnchor,
    status: "active",
    observationCount: 1,
  } satisfies Session);

  let statusFlips = 0;
  let prevStatus: string | undefined;
  const cycleAnchors: string[] = [baseAnchor];

  for (let cycle = 0; cycle < 3; cycle++) {
    await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId] },
    });
    const after = await getSession(kv, sessionId);
    if (!after) {
      details.push(`FAIL: session missing after cycle ${cycle} sweep`);
      return { name, passed: false, details };
    }
    if (prevStatus !== undefined && prevStatus !== after.status) statusFlips++;
    else if (prevStatus === undefined && after.status === "completed") statusFlips++;
    prevStatus = after.status;

    const nextAnchorHoursAgo = 22 - cycle * 7;
    const nextAnchor = new Date(now - nextAnchorHoursAgo * HOUR_MS).toISOString();
    cycleAnchors.push(nextAnchor);
    await simulatePostCompletionActivity(kv, sessionId, nextAnchor);
  }

  if (statusFlips !== 1) {
    details.push(`FAIL: expected exactly 1 status flip (active->completed), got ${statusFlips}`);
    return { name, passed: false, details };
  }
  const stoppedTriggers = sdk.triggerCalls.filter((c) => c.function_id === "event::session::stopped");
  const checkpointTriggers = sdk.triggerCalls.filter((c) => c.function_id === "event::session::checkpoint");
  if (stoppedTriggers.length !== 1) {
    details.push(`FAIL: expected 1 stopped trigger across 3 cycles, got ${stoppedTriggers.length}`);
    return { name, passed: false, details };
  }
  if (checkpointTriggers.length !== 2) {
    details.push(`FAIL: expected 2 checkpoint triggers across 3 cycles (cycles 2 and 3), got ${checkpointTriggers.length}`);
    return { name, passed: false, details };
  }

  const final = await getSession(kv, sessionId);
  if (!final || final.status !== "completed") {
    details.push(`FAIL: final status expected completed, got ${final?.status}`);
    return { name, passed: false, details };
  }
  if (final.lastCheckpointAt !== cycleAnchors[cycleAnchors.length - 2]) {
    details.push(
      `FAIL: final lastCheckpointAt expected ${cycleAnchors[cycleAnchors.length - 2]}, got ${final.lastCheckpointAt}`,
    );
    return { name, passed: false, details };
  }

  details.push(
    `pass: status flipped active->completed exactly once across 3 cycles`,
  );
  details.push(
    `pass: 1 stopped + 2 checkpoint triggers (cycle 1 close, cycle 2 + 3 checkpoint), final lastCheckpointAt=${final.lastCheckpointAt}`,
  );
  return { name, passed: true, details };
}

async function main() {
  const scenarios = [scenarioS1, scenarioS2, scenarioS3];
  let allPassed = true;
  for (const run of scenarios) {
    const report = await run();
    const status = report.passed ? "PASS" : "FAIL";
    console.log(`${report.name}: ${status}`);
    for (const detail of report.details) {
      console.log(`  ${detail}`);
    }
    if (!report.passed) allPassed = false;
  }
  if (!allPassed) {
    console.error("smoke-session-checkpoint: one or more scenarios failed");
    process.exit(1);
  }
  console.log("smoke-session-checkpoint: all scenarios passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke-session-checkpoint: uncaught error", err);
  process.exit(2);
});
