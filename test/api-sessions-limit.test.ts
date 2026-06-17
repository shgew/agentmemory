import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    update: async <T>(scope: string, key: string): Promise<T> =>
      store.get(scope)?.get(key) as T,
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
  const functions = new Map<string, Function>();
  return {
    registerFunction: vi.fn(
      (idOrOpts: string | { id: string }, handler: Function) => {
        const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
        functions.set(id, handler);
      },
    ),
    registerTrigger: vi.fn(),
    trigger: vi.fn(),
    getFunction: (id: string) => functions.get(id),
  };
}

function session(id: string, updatedSecond: number): Session {
  return {
    id,
    project: "/tmp/p",
    cwd: "/tmp/p",
    startedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: `2026-06-01T00:00:${String(updatedSecond).padStart(2, "0")}.000Z`,
    status: "active",
    observationCount: 1,
  };
}

function reqWithLimit(limit?: string) {
  return {
    body: undefined,
    headers: {},
    query_params: limit === undefined ? {} : { limit },
  };
}

type SessionsResponse = {
  status_code: number;
  body: { sessions: Array<{ id: string }> };
};

describe("api::sessions limit + recency", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  async function seed(count: number) {
    for (let i = 0; i < count; i++) {
      await kv.set(KV.sessions, `s${i}`, session(`s${i}`, i % 60));
    }
  }

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
  });

  it("defaults to 20 and returns the most-recent first", async () => {
    await seed(25);
    const fn = sdk.getFunction("api::sessions")!;
    const res = (await fn(reqWithLimit())) as SessionsResponse;

    expect(res.status_code).toBe(200);
    expect(res.body.sessions).toHaveLength(20);
    expect(res.body.sessions[0].id).toBe("s24");
    const ids = res.body.sessions.map((s) => s.id);
    for (const old of ["s0", "s1", "s2", "s3", "s4"]) {
      expect(ids).not.toContain(old);
    }
  });

  it("honors an explicit limit", async () => {
    await seed(25);
    const fn = sdk.getFunction("api::sessions")!;
    const res = (await fn(reqWithLimit("5"))) as SessionsResponse;

    expect(res.body.sessions).toHaveLength(5);
    expect(res.body.sessions.map((s) => s.id)).toEqual([
      "s24",
      "s23",
      "s22",
      "s21",
      "s20",
    ]);
  });

  it("clamps an over-large limit to 200", async () => {
    await seed(205);
    const fn = sdk.getFunction("api::sessions")!;
    const res = (await fn(reqWithLimit("1000"))) as SessionsResponse;

    expect(res.body.sessions).toHaveLength(200);
  });

  it("clamps a non-positive limit to 1", async () => {
    await seed(5);
    const fn = sdk.getFunction("api::sessions")!;
    const res = (await fn(reqWithLimit("0"))) as SessionsResponse;

    expect(res.body.sessions).toHaveLength(1);
  });
});
