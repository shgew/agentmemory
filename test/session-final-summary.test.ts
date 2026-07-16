import { describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/slots.js", () => ({
  isReflectEnabled: () => true,
}));

vi.mock("../src/config.js", () => ({
  isGraphExtractionEnabled: () => true,
  getAgentId: () => undefined,
  getEnvVar: () => undefined,
  isAutoCompressEnabled: () => false,
}));

import { registerSessionSweepFunction } from "../src/functions/session-sweep.js";
import { registerSummarizeFunction } from "../src/functions/summarize.js";
import { KV } from "../src/state/schema.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import type {
  CompressedObservation,
  MemoryProvider,
  RawObservation,
  Session,
  SessionSummary,
} from "../src/types.js";

type TriggerCall = {
  function_id: string;
  payload?: unknown;
  timeoutMs?: number;
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    update: async <T>(
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ): Promise<T> => {
      const current = (store.get(scope)?.get(key) as Record<string, unknown>) ?? {};
      const next = { ...current };
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
  const calls: TriggerCall[] = [];
  const functions = new Map<string, (data: unknown) => unknown | Promise<unknown>>();
  return {
    calls,
    registerFunction: (
      idOrOptions: string | { id: string },
      handler: (data: unknown) => unknown | Promise<unknown>,
    ) => {
      const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (call: TriggerCall): Promise<unknown> => {
      calls.push(call);
      const handler = functions.get(call.function_id);
      if (!handler) return undefined;
      return handler(call.payload);
    },
  };
}

function summaryXml(): string {
  return `<summary>
<title>Final session summary</title>
<narrative>Session finalized after all observations were captured.</narrative>
<decisions><decision>Persist the final summary before completion.</decision></decisions>
<files><file>src/functions/session-sweep.ts</file></files>
<concepts><concept>session-finalization</concept></concepts>
</summary>`;
}

function makeProvider(gate?: Promise<void>, entered?: () => void) {
  const provider: MemoryProvider & {
    summarizeCalls: number;
    shouldFail: boolean;
  } = {
    name: "test",
    summarizeCalls: 0,
    shouldFail: false,
    compress: async () => "",
    summarize: async () => {
      provider.summarizeCalls += 1;
      entered?.();
      if (gate) await gate;
      if (provider.shouldFail) throw new Error("simulated summarize failure");
      return summaryXml();
    },
  };
  return provider;
}

function makeSession(sessionId: string, anchor: string, observationCount: number): Session {
  return {
    id: sessionId,
    project: "test-project",
    cwd: "/tmp",
    startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: anchor,
    lastCheckpointAt: anchor,
    status: "active",
    observationCount,
  };
}

function makeObservation(sessionId: string, id: string, timestamp: string): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp,
    sourceType: "post_tool_use",
    type: "conversation",
    title: `Observation ${id}`,
    facts: [`Fact ${id}`],
    narrative: `Narrative ${id}`,
    concepts: ["session-finalization"],
    files: ["src/functions/session-sweep.ts"],
    importance: 8,
  };
}

async function setupSession(
  sessionId: string,
  sessionObservationCount: number,
  storedObservationCount: number,
  provider: ReturnType<typeof makeProvider>,
) {
  const sdk = mockSdk();
  const kv = mockKV();
  const graphExtract = vi.fn(async () => ({ success: true }));
  const slotReflect = vi.fn(async () => ({ success: true }));
  registerSessionSweepFunction(sdk as never, kv as never);
  registerEventTriggers(sdk as never, kv as never);
  registerSummarizeFunction(sdk as never, kv as never, provider);
  sdk.registerFunction("mem::graph-extract", graphExtract);
  sdk.registerFunction("mem::slot-reflect", slotReflect);

  const anchor = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  await kv.set(KV.sessions, sessionId, makeSession(sessionId, anchor, sessionObservationCount));
  for (let index = 0; index < storedObservationCount; index += 1) {
    const observation = makeObservation(sessionId, `obs_${index}`, anchor);
    await kv.set(KV.observations(sessionId), observation.id, observation);
  }
  return { sdk, kv, graphExtract, slotReflect };
}

describe("session sweep final summary", () => {
  it("writes one summary-only result before completing a no-delta session", async () => {
    const sessionId = "ses_no_delta_summary";
    const provider = makeProvider();
    const { sdk, kv, graphExtract, slotReflect } = await setupSession(
      sessionId,
      2,
      2,
      provider,
    );

    const result = await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId], mode: "finalize" },
    });

    expect(result).toMatchObject({ swept: [sessionId], failed: [] });
    expect(sdk.calls.filter((call) => call.function_id === "mem::summarize")).toHaveLength(1);
    expect(graphExtract).not.toHaveBeenCalled();
    expect(slotReflect).not.toHaveBeenCalled();
    expect(await kv.get<Session>(KV.sessions, sessionId)).toMatchObject({ status: "completed" });
    expect(await kv.get<SessionSummary>(KV.summaries, sessionId)).toMatchObject({
      sessionId,
      observationCount: 2,
      title: "Final session summary",
    });
  });

  it("replaces a stale summary using the stored observation count instead of the session field", async () => {
    const sessionId = "ses_stale_summary";
    const provider = makeProvider();
    const { sdk, kv } = await setupSession(sessionId, 1, 2, provider);
    await kv.set(KV.summaries, sessionId, {
      sessionId,
      project: "test-project",
      createdAt: new Date().toISOString(),
      title: "Stale summary",
      narrative: "Only one observation was summarized.",
      keyDecisions: [],
      filesModified: [],
      concepts: [],
      observationCount: 1,
    } satisfies SessionSummary);

    await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId], mode: "finalize" },
    });

    expect(sdk.calls.filter((call) => call.function_id === "mem::summarize")).toHaveLength(1);
    expect(await kv.get<SessionSummary>(KV.summaries, sessionId)).toMatchObject({
      title: "Final session summary",
      observationCount: 2,
    });
  });

  it("recovers pending compression from a completed no-delta session", async () => {
    const sessionId = "ses_pending_compression";
    const provider = makeProvider();
    const { sdk, kv, graphExtract } = await setupSession(
      sessionId,
      1,
      1,
      provider,
    );
    const session = await kv.get<Session>(KV.sessions, sessionId);
    const anchor = session?.updatedAt ?? session!.startedAt;
    const timestamp = new Date(new Date(anchor).getTime() + 1_000).toISOString();
    await kv.update<Session>(KV.sessions, sessionId, [
      {
        type: "set",
        path: "status",
        value: "completed",
      },
      {
        type: "set",
        path: "lastCheckpointAt",
        value: anchor,
      },
    ]);
    const raw: RawObservation = {
      id: "obs_pending",
      sessionId,
      timestamp,
      hookType: "prompt_submit",
      raw: { prompt: "retain this" },
      userPrompt: "retain this",
    };
    await kv.set(KV.rawPayloads, raw.id, raw);
    const compress = vi.fn(async () => {
      await kv.set(
        KV.observations(sessionId),
        raw.id,
        makeObservation(sessionId, raw.id, timestamp),
      );
      return { success: true };
    });
    sdk.registerFunction("mem::compress", compress);

    const result = await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId], mode: "finalize" },
    });

    expect(result).toMatchObject({
      swept: [],
      checkpointed: [sessionId],
      failed: [],
    });
    expect(compress).toHaveBeenCalledOnce();
    expect(graphExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        observations: expect.arrayContaining([
          expect.objectContaining({ id: "obs_0" }),
          expect.objectContaining({ id: raw.id }),
        ]),
      }),
    );
    expect(await kv.get<SessionSummary>(KV.summaries, sessionId)).toMatchObject({
      observationCount: 2,
    });
  });

  it("leaves a failed no-delta session active and retries it on the next sweep", async () => {
    const sessionId = "ses_summary_retry";
    const provider = makeProvider();
    provider.shouldFail = true;
    const { sdk, kv } = await setupSession(sessionId, 1, 1, provider);

    const failed = await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId], mode: "finalize" },
    });

    expect(failed).toMatchObject({ swept: [], failed: [{ sessionId }] });
    expect(await kv.get<Session>(KV.sessions, sessionId)).toMatchObject({ status: "active" });
    expect(await kv.get<SessionSummary>(KV.summaries, sessionId)).toBeNull();

    provider.shouldFail = false;
    const retried = await sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId], mode: "finalize" },
    });

    expect(retried).toMatchObject({ swept: [sessionId], failed: [] });
    expect(sdk.calls.filter((call) => call.function_id === "mem::summarize")).toHaveLength(2);
    expect(await kv.get<Session>(KV.sessions, sessionId)).toMatchObject({ status: "completed" });
  });

  it.each(["no_provider", "no_observations"] as const)(
    "completes a no-delta session after permanent summarize no-op: %s",
    async (error) => {
      const sessionId = `ses_permanent_noop_${error}`;
      const observationCount = error === "no_observations" ? 0 : 1;
      const provider = makeProvider();
      const { sdk, kv } = await setupSession(
        sessionId,
        observationCount,
        observationCount,
        provider,
      );
      sdk.registerFunction("mem::summarize", async () => ({ success: false, error }));

      const finalized = await sdk.trigger({
        function_id: "mem::session-sweep",
        payload: { sessionIds: [sessionId], mode: "finalize" },
      });
      const repeated = await sdk.trigger({
        function_id: "mem::session-sweep",
        payload: { sessionIds: [sessionId], mode: "finalize" },
      });

      expect(finalized).toMatchObject({ swept: [sessionId], failed: [] });
      expect(repeated).toMatchObject({ swept: [], skipped: [sessionId], failed: [] });
      expect(sdk.calls.filter((call) => call.function_id === "mem::summarize")).toHaveLength(1);
      expect(await kv.get<Session>(KV.sessions, sessionId)).toMatchObject({ status: "completed" });
      expect(await kv.get<SessionSummary>(KV.summaries, sessionId)).toBeNull();
    },
  );

  it("serializes concurrent session end and sweep finalization", async () => {
    const sessionId = "ses_end_sweep_race";
    const summarizeGate = deferred();
    const summarizeEntered = deferred();
    const provider = makeProvider(summarizeGate.promise, () => summarizeEntered.resolve());
    const { sdk, kv } = await setupSession(sessionId, 1, 1, provider);

    const endPromise = sdk.trigger({
      function_id: "event::session::ended",
      payload: { sessionId },
    });
    await summarizeEntered.promise;
    const sweepPromise = sdk.trigger({
      function_id: "mem::session-sweep",
      payload: { sessionIds: [sessionId], mode: "finalize" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(
      sdk.calls.filter((call) => call.function_id === "event::session::stopped"),
    ).toHaveLength(1);
    summarizeGate.resolve();
    await Promise.all([endPromise, sweepPromise]);

    expect(sdk.calls.filter((call) => call.function_id === "event::session::stopped")).toHaveLength(1);
    expect(sdk.calls.filter((call) => call.function_id === "mem::summarize")).toHaveLength(1);
    expect(await kv.get<SessionSummary>(KV.summaries, sessionId)).toMatchObject({
      sessionId,
      observationCount: 1,
    });
    expect(await kv.get<Session>(KV.sessions, sessionId)).toMatchObject({ status: "completed" });
  });
});
