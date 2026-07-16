import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchAdd: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: mocks.loggerInfo, warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ add: mocks.searchAdd, has: () => false }),
  vectorIndexAddGuarded: vi.fn().mockResolvedValue(false),
}));

export function getSearchAddMock() {
  return mocks.searchAdd;
}

export function getLoggerInfoMock() {
  return mocks.loggerInfo;
}

export function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)?.set(key, data);
      return data;
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ): Promise<void> => {
      const row = store.get(scope)?.get(key);
      if (!row || typeof row !== "object") return;
      const updated = { ...row } as Record<string, unknown>;
      for (const change of updates) updated[change.path] = change.value;
      store.get(scope)?.set(key, updated);
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

export function mockSdk() {
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

export function resetCaptureMocks(): void {
  vi.resetModules();
  mocks.searchAdd.mockClear();
  mocks.loggerInfo.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "");
}
