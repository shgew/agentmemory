import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCompressFunction } from "../src/functions/compress.js";
import type { MemoryProvider, RawObservation } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  searchAdd: vi.fn(),
  vectorAdd: vi.fn().mockResolvedValue(false),
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({
    add: mocks.searchAdd,
    has: () => false,
  }),
  vectorIndexAddGuarded: mocks.vectorAdd,
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)?.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, (payload: unknown) => unknown>();
  return {
    registerFunction: (
      idOrOptions: string | { id: string },
      handler: (payload: unknown) => unknown,
    ): void => {
      functions.set(
        typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id,
        handler,
      );
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      payload?: unknown,
    ): Promise<unknown> => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const input = typeof idOrInput === "string" ? payload : idOrInput.payload;
      return functions.get(id)?.(input) ?? null;
    },
  };
}

describe("LLM compression vector policy", () => {
  beforeEach(() => {
    mocks.searchAdd.mockClear();
    mocks.vectorAdd.mockClear();
  });

  it("keeps command compressions BM25-only", async () => {
    const provider: MemoryProvider = {
      name: "test",
      compress: async () => `<type>command_run</type>
<title>npm test</title>
<facts><fact>tests passed</fact></facts>
<narrative>tests passed</narrative>
<concepts><concept>testing</concept></concepts>
<files></files>
<importance>5</importance>`,
      summarize: async () => "",
    };
    const sdk = mockSdk();
    const kv = mockKV();
    registerCompressFunction(sdk as never, kv as never, provider);
    const raw: RawObservation = {
      id: "obs_command",
      sessionId: "ses_command",
      timestamp: "2026-07-15T10:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "bash",
      toolInput: { command: "npm test" },
      toolOutput: "passed",
      raw: {},
    };

    const result = await sdk.trigger("mem::compress", {
      observationId: raw.id,
      sessionId: raw.sessionId,
      raw,
    });

    expect(result).toMatchObject({ success: true });
    expect(mocks.searchAdd).toHaveBeenCalledOnce();
    expect(mocks.vectorAdd).not.toHaveBeenCalled();
  });
});
