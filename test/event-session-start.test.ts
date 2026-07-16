import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../src/logger.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";
import { registerEventTriggers } from "../src/triggers/events.js";

type Handler = (data: unknown) => unknown | Promise<unknown>;
type UpdateOp = { type: string; path: string; value?: unknown };

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const seed = (scope: string, key: string, value: unknown): void => {
    if (!store.has(scope)) store.set(scope, new Map());
    store.get(scope)?.set(key, value);
  };
  return {
    seed,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      seed(scope, key, value);
      return value;
    },
    update: async <T>(scope: string, key: string, ops: UpdateOp[]): Promise<T> => {
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

describe("event::session::started", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let start: Handler;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = mockSdk();
    kv = mockKV();
    registerEventTriggers(sdk as never, kv as never);
    start = sdk.getFunction("event::session::started");
  });

  it("preserves completed lifecycle state and repairs the observation count", async () => {
    const existing: Session = {
      id: "event-resume",
      project: "project",
      cwd: "/existing",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T01:00:00.000Z",
      lastCheckpointAt: "2026-01-01T00:59:00.000Z",
      status: "completed",
      observationCount: 1,
      commitShas: ["abc123"],
      parentSessionId: "parent-1",
    };
    kv.seed(KV.sessions, existing.id, existing);
    for (const id of ["obs-1", "obs-2", "obs-3"]) {
      kv.seed(KV.observations(existing.id), id, { id });
    }

    const result = (await start({
      sessionId: existing.id,
      project: existing.project,
      cwd: "/incoming",
    })) as { session: Session };

    expect(result.session).toEqual({ ...existing, observationCount: 3 });
    expect(await kv.get<Session>(KV.sessions, existing.id)).toEqual(result.session);
  });

  it("keeps existing project identity and logs event-path conflicts", async () => {
    const existing: Session = {
      id: "event-conflict",
      project: "existing-project",
      cwd: "/existing",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      observationCount: 0,
    };
    kv.seed(KV.sessions, existing.id, existing);

    const result = (await start({
      sessionId: existing.id,
      project: "incoming-project",
      cwd: "/incoming",
    })) as { session: Session };

    expect(result.session.project).toBe(existing.project);
    expect(sdk.contextPayloads).toContainEqual({
      sessionId: existing.id,
      project: existing.project,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Session project conflict on start",
      {
        sessionId: existing.id,
        existingProject: existing.project,
        incomingProject: "incoming-project",
      },
    );
  });
});
