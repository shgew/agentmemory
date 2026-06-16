import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    update: async <T>(scope: string, key: string, patches: unknown[]): Promise<T> => {
      const current = store.get(scope)?.get(key) as T;
      if (current && patches.length > 0) {
        const patch = patches[0] as { path?: string; value?: unknown };
        if (patch.path) {
          const next = { ...(current as Record<string, unknown>) };
          next[patch.path] = patch.value;
          store.get(scope)!.set(key, next);
          return next as T;
        }
      }
      return current;
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
  const functions = new Map<string, Function>();
  const triggerOverrides = new Map<string, Function>();
  const registerFunction = vi.fn((idOrOpts: string | { id: string }, handler: Function) => {
    const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
    functions.set(id, handler);
  });
  return {
    registerFunction,
    registerTrigger: vi.fn(),
    trigger: vi.fn(async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const override = triggerOverrides.get(id);
      if (override) return override(payload);
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    }),
    overrideTrigger: (id: string, handler: Function) => {
      triggerOverrides.set(id, handler);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function makeReq(body?: unknown, headers?: Record<string, string>) {
  return {
    body,
    headers: headers || {},
    query_params: {},
  };
}

describe("api::session::checkpoint", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
  });

  it("returns 200 when mem::session::checkpoint queues work", async () => {
    sdk.overrideTrigger("mem::session::checkpoint", async () => ({ success: true, queued: true }));

    const fn = sdk.getFunction("api::session::checkpoint")!;
    const result = (await fn(makeReq({ sessionId: "ses_1" }))) as { status_code: number; body: { success: boolean } };

    expect(result.status_code).toBe(200);
    expect(result.body.success).toBe(true);
  });

  it("returns 400 when sessionId is missing", async () => {
    const fn = sdk.getFunction("api::session::checkpoint")!;
    const result = (await fn(makeReq({}))) as { status_code: number };

    expect(result.status_code).toBe(400);
  });

  it("returns 400 when sessionId is an empty string", async () => {
    const fn = sdk.getFunction("api::session::checkpoint")!;
    const result = (await fn(makeReq({ sessionId: "" }))) as { status_code: number };

    expect(result.status_code).toBe(400);
  });

  it("returns 404 when mem::session::checkpoint reports session_not_found", async () => {
    sdk.overrideTrigger("mem::session::checkpoint", async () => ({ success: false, error: "session_not_found" }));

    const fn = sdk.getFunction("api::session::checkpoint")!;
    const result = (await fn(makeReq({ sessionId: "ghost" }))) as { status_code: number };

    expect(result.status_code).toBe(404);
  });

  it("returns 409 when mem::session::checkpoint reports session_not_active", async () => {
    sdk.overrideTrigger("mem::session::checkpoint", async () => ({ success: false, error: "session_not_active" }));

    const fn = sdk.getFunction("api::session::checkpoint")!;
    const result = (await fn(makeReq({ sessionId: "ses_1" }))) as { status_code: number };

    expect(result.status_code).toBe(409);
  });

  it("returns 401 when secret is set and Authorization is missing", async () => {
    const authedSdk = mockSdk();
    const authedKv = mockKV();
    registerApiTriggers(authedSdk as never, authedKv as never, "test-secret");

    const fn = authedSdk.getFunction("api::session::checkpoint")!;
    const result = (await fn(makeReq({ sessionId: "ses_1" }))) as { status_code: number };

    expect(result.status_code).toBe(401);
  });
});
