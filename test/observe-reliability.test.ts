import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ) => {
      const m = store.get(scope);
      if (!m) return;
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk(opts: { rejectStreams?: boolean } = {}) {
  const fns = new Map<string, Function>();
  const triggered: Array<{ id: string; data: unknown }> = [];
  return {
    fns,
    triggered,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
      _options?: Record<string, unknown>,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      triggered.push({ id, data: payload });
      if (
        opts.rejectStreams &&
        (id === "stream::set" || id === "stream::send")
      ) {
        throw new Error("stream worker disconnected");
      }
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

describe("mem::observe — observation cap is an intentional drop, not a failure", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });

  it("at cap: returns a non-failure result, does not increment, and avoids the O(n) kv.list", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const listSpy = vi.spyOn(kv, "list");
    registerObserveFunction(sdk as never, kv as never, undefined, 2);

    // Session at cap, plus matching observation rows so the OLD list-based
    // check trips too — isolates the shape change from the mechanism change.
    await kv.set("mem:sessions", "ses_cap", {
      id: "ses_cap",
      project: "/r",
      cwd: "/r",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 2,
    });
    await kv.set("mem:obs:ses_cap", "obs_a", { id: "obs_a" });
    await kv.set("mem:obs:ses_cap", "obs_b", { id: "obs_b" });

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_cap",
      project: "/r",
      cwd: "/r",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    })) as Record<string, unknown>;

    // instrument.ts only treats success===false as a failure; the cap drop
    // must NOT carry that field.
    expect(result.success).not.toBe(false);
    expect(result.limitReached).toBe(true);

    // Intentional drop: no new observation stored, counter unchanged.
    const session = kv.store.get("mem:sessions")!.get("ses_cap") as Record<
      string,
      unknown
    >;
    expect(session.observationCount).toBe(2);
    expect(kv.store.get("mem:obs:ses_cap")!.size).toBe(2);

    // O(1) cap check: must not enumerate every observation in the session.
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("under cap: still captures normally and increments the counter", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, undefined, 500);

    await kv.set("mem:sessions", "ses_ok", {
      id: "ses_ok",
      project: "/r",
      cwd: "/r",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 5,
    });

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_ok",
      project: "/r",
      cwd: "/r",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    })) as Record<string, unknown>;

    expect(result.observationId).toBeTruthy();
    const session = kv.store.get("mem:sessions")!.get("ses_ok") as Record<
      string,
      unknown
    >;
    expect(session.observationCount).toBe(6);
  });

  it("brand-new session (no record) with project+cwd: count treated as 0, still implicit-creates", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, undefined, 500);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_new",
      project: "/home/user/repo",
      cwd: "/home/user/repo",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: { prompt: "do the thing" },
    })) as Record<string, unknown>;

    expect(result.observationId).toBeTruthy();
    const session = kv.store.get("mem:sessions")!.get("ses_new") as Record<
      string,
      unknown
    >;
    expect(session).toBeTruthy();
    expect(session.observationCount).toBe(1);
  });
});

describe("mem::observe — stream publish failures are non-fatal", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });

  it("a rejected stream publish still returns {observationId} and persists the observation", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk({ rejectStreams: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_stream",
      project: "/r",
      cwd: "/r",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: { file_path: "x.ts" } },
    })) as Record<string, unknown>;

    // observe must NOT throw / fail just because the live-viewer stream is down
    expect(result.observationId).toBeTruthy();

    // Durable path still completed: the synthetic CompressedObservation persisted.
    const stored = kv.store.get("mem:obs:ses_stream");
    expect(stored).toBeDefined();
    const obs = Array.from(stored!.values())[0] as { type?: string };
    expect(obs.type).toBeTruthy();
  });
});
