import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../src/logger.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";
import { registerApiTriggers } from "../src/triggers/api.js";

type Handler = (data: unknown) => unknown | Promise<unknown>;
type UpdateOp = { type: string; path: string; value?: unknown };
type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const setCalls: Array<{ scope: string; key: string }> = [];
  const updateCalls: Array<{ scope: string; key: string; ops: UpdateOp[] }> = [];
  let blockedSet: { scope: string; key: string; entered: Deferred; release: Deferred } | undefined;
  let didBlockSet = false;

  const seed = (scope: string, key: string, value: unknown): void => {
    if (!store.has(scope)) store.set(scope, new Map());
    store.get(scope)?.set(key, value);
  };

  return {
    setCalls,
    updateCalls,
    seed,
    blockFirstSet: (scope: string, key: string) => {
      blockedSet = { scope, key, entered: deferred(), release: deferred() };
      return blockedSet;
    },
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      setCalls.push({ scope, key });
      if (
        blockedSet &&
        !didBlockSet &&
        blockedSet.scope === scope &&
        blockedSet.key === key
      ) {
        didBlockSet = true;
        blockedSet.entered.resolve();
        await blockedSet.release.promise;
      }
      seed(scope, key, value);
      return value;
    },
    update: async <T>(scope: string, key: string, ops: UpdateOp[]): Promise<T> => {
      updateCalls.push({ scope, key, ops });
      const current = (store.get(scope)?.get(key) as Record<string, unknown>) ?? {};
      const next = { ...current };
      for (const op of ops) {
        if (op.type === "set") next[op.path] = op.value;
      }
      seed(scope, key, next);
      return next as T;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, Handler>();
  const contextPayloads: unknown[] = [];
  return {
    contextPayloads,
    registerFunction: (
      idOrOptions: string | { id: string },
      handler: Handler,
    ): void => {
      functions.set(
        typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id,
        handler,
      );
    },
    registerTrigger: (): void => {},
    trigger: async (input: { function_id: string; payload?: unknown }) => {
      if (input.function_id === "mem::context") {
        contextPayloads.push(input.payload);
        return { context: "context" };
      }
      return functions.get(input.function_id)?.(input.payload);
    },
    getFunction: (id: string): Handler => {
      const handler = functions.get(id);
      if (!handler) throw new Error(`Function ${id} was not registered`);
      return handler;
    },
  };
}

function request(body: Record<string, unknown>) {
  return { body, headers: {}, query_params: {} };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "resume-session",
    project: "existing-project",
    cwd: "/existing",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    observationCount: 7,
    ...overrides,
  };
}

type StartResponse = {
  status_code: number;
  body: { session: Session; context: string; projectConflict?: boolean };
};

describe("api::session::start", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let start: Handler;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    start = sdk.getFunction("api::session::start");
  });

  it("creates a new active session with zero observations", async () => {
    const result = (await start(
      request({ sessionId: "new-session", project: "project", cwd: "/repo" }),
    )) as StartResponse;

    expect(result.status_code).toBe(200);
    expect(result.body.session).toMatchObject({
      id: "new-session",
      project: "project",
      cwd: "/repo",
      status: "active",
      observationCount: 0,
    });
    expect(result.body.projectConflict).toBe(false);
  });

  it("preserves durable completed-session fields on an ordinary repeated start", async () => {
    const existing = session({
      cwd: "",
      status: "completed",
      endedAt: "2026-01-01T01:00:00.000Z",
      lastCheckpointAt: "2026-01-01T00:59:00.000Z",
      commitShas: ["abc123"],
      parentSessionId: "original-parent",
      summary: "",
    });
    kv.seed(KV.sessions, existing.id, existing);

    const result = (await start(
      request({
        sessionId: existing.id,
        project: existing.project,
        cwd: "/incoming",
        title: "resumed title",
        agentId: "reviewer",
        parentID: "original-parent",
      }),
    )) as StartResponse;

    expect(result.body.session).toEqual({
      ...existing,
      cwd: "/incoming",
      summary: "resumed title",
      firstPrompt: "resumed title",
      agentId: "reviewer",
    });
    expect(await kv.get<Session>(KV.sessions, existing.id)).toEqual(result.body.session);
  });

  it("reopens a completed session only when resumed is explicitly true", async () => {
    const existing = session({
      status: "completed",
      endedAt: "2026-01-01T01:00:00.000Z",
      lastCheckpointAt: "2026-01-01T00:59:00.000Z",
      commitShas: ["abc123"],
    });
    kv.seed(KV.sessions, existing.id, existing);

    const result = (await start(
      request({
        sessionId: existing.id,
        project: existing.project,
        cwd: existing.cwd,
        resumed: true,
      }),
    )) as StartResponse;

    expect(result.body.session).toEqual({
      ...existing,
      status: "active",
      updatedAt: expect.any(String),
    });
    expect(Date.parse(result.body.session.updatedAt ?? "")).toBeGreaterThan(
      Date.parse(existing.endedAt ?? ""),
    );
    expect(await kv.get<Session>(KV.sessions, existing.id)).toEqual(
      result.body.session,
    );
  });

  it("preserves commitShas when resuming a session", async () => {
    const existing = session({ commitShas: ["abc123", "def456"] });
    kv.seed(KV.sessions, existing.id, existing);

    const result = (await start(
      request({ sessionId: existing.id, project: existing.project, cwd: existing.cwd }),
    )) as StartResponse;

    expect(result.body.session.commitShas).toEqual(["abc123", "def456"]);
    expect((await kv.get<Session>(KV.sessions, existing.id))?.commitShas).toEqual([
      "abc123",
      "def456",
    ]);
  });

  it("repairs an under-counted session from stored observations without decreasing it", async () => {
    const existing = session({ observationCount: 1 });
    kv.seed(KV.sessions, existing.id, existing);
    for (const id of ["obs-1", "obs-2", "obs-3"]) {
      kv.seed(KV.observations(existing.id), id, { id });
    }

    const result = (await start(
      request({ sessionId: existing.id, project: existing.project, cwd: existing.cwd }),
    )) as StartResponse;

    expect(result.body.session.observationCount).toBe(3);
    expect((await kv.get<Session>(KV.sessions, existing.id))?.observationCount).toBe(3);
  });

  it("keeps existing project identity and surfaces conflicts", async () => {
    const existing = session();
    kv.seed(KV.sessions, existing.id, existing);

    const result = (await start(
      request({ sessionId: existing.id, project: "incoming-project", cwd: existing.cwd }),
    )) as StartResponse;

    expect(result.status_code).toBe(409);
    expect(result.body.session.project).toBe(existing.project);
    expect(result.body.projectConflict).toBe(true);
    expect(sdk.contextPayloads).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Session project conflict on start",
      {
        sessionId: existing.id,
        existingProject: existing.project,
        incomingProject: "incoming-project",
      },
    );
  });

  it("rejects a parent conflict before enriching durable metadata", async () => {
    const existing = session({
      cwd: "",
      summary: "",
      parentSessionId: "original-parent",
    });
    kv.seed(KV.sessions, existing.id, existing);

    const result = (await start(
      request({
        sessionId: existing.id,
        project: existing.project,
        cwd: "/incoming",
        title: "incoming title",
        parentID: "different-parent",
      }),
    )) as StartResponse;

    expect(result.status_code).toBe(409);
    expect(await kv.get<Session>(KV.sessions, existing.id)).toEqual(existing);
    expect(kv.updateCalls).toEqual([]);
  });

  it("serializes concurrent starts into one create and one enrich", async () => {
    const sessionId = "concurrent-session";
    const gate = kv.blockFirstSet(KV.sessions, sessionId);
    const first = start(request({ sessionId, project: "project", cwd: "/repo" }));
    await gate.entered.promise;

    const second = start(
      request({ sessionId, project: "project", cwd: "/repo", title: "second title" }),
    );
    await Promise.resolve();
    gate.release.resolve();
    const [firstResult, secondResult] = (await Promise.all([first, second])) as [
      StartResponse,
      StartResponse,
    ];

    expect(kv.setCalls.filter((call) => call.scope === KV.sessions)).toHaveLength(1);
    expect(kv.updateCalls.filter((call) => call.scope === KV.sessions)).toHaveLength(1);
    expect(await kv.list<Session>(KV.sessions)).toHaveLength(1);
    expect((await kv.get<Session>(KV.sessions, sessionId))?.summary).toBe("second title");
    expect(firstResult.body.session.startedAt).toBe(secondResult.body.session.startedAt);
  });

  it.each([
    [{ project: "project", cwd: "/repo" }],
    [{ sessionId: "", project: "project", cwd: "/repo" }],
    [{ sessionId: "session", cwd: "/repo" }],
    [{ sessionId: "session", project: "", cwd: "/repo" }],
    [{ sessionId: "session", project: "project" }],
    [{ sessionId: "session", project: "project", cwd: "" }],
  ])("keeps required-field validation unchanged for %o", async (body) => {
    const result = (await start(request(body))) as StartResponse;

    expect(result.status_code).toBe(400);
  });
});
