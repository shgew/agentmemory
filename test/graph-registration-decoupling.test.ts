import { describe, it, expect, vi, afterEach } from "vitest";
import { registerGraphFunctions } from "../src/index.js";
import type { MemoryProvider } from "../src/types.js";

// Deliverable #3: graph read/query API registration is DECOUPLED from graph
// extraction. Historically index.ts gated registerGraphFunction (which
// registers mem::graph-query, mem::graph-stats, and the extract fn together)
// behind isGraphExtractionEnabled(), so freezing extraction ALSO made existing
// graph data unqueryable. The decoupling registers read/query unconditionally
// while keeping extraction *production* (auto-extract on session events, gated
// in triggers/events.ts) and the graph-specific provider construction gated.

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async (scope: string, key: string) => store.get(scope)?.get(key) ?? null,
    set: async (scope: string, key: string, data: unknown) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async (scope: string) => {
      const entries = store.get(scope);
      return entries ? Array.from(entries.values()) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  const sdk = {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
  return { sdk, functions };
}

const stubProvider = {
  name: "stub",
  compress: async () => "",
  summarize: async () => "",
} as unknown as MemoryProvider;

// Every graph API registerGraphFunction wires. Read/query/maintenance must be
// available regardless of extraction; extract is the production entry point.
const READ_QUERY_FNS = [
  "mem::graph-query",
  "mem::graph-stats",
  "mem::graph-snapshot-rebuild",
  "mem::graph-reset",
];

describe("graph API registration decoupling (registerGraphFunctions)", () => {
  const original = process.env.GRAPH_EXTRACTION_ENABLED;

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.GRAPH_EXTRACTION_ENABLED;
    else process.env.GRAPH_EXTRACTION_ENABLED = original;
  });

  it("registers graph read/query APIs even when GRAPH_EXTRACTION_ENABLED=false", () => {
    process.env.GRAPH_EXTRACTION_ENABLED = "false";
    const { sdk, functions } = mockSdk();
    const buildGraphProvider = vi.fn(() => ({
      provider: stubProvider,
      model: "m",
      baseModel: "m",
    }));

    registerGraphFunctions(
      sdk as never,
      mockKV() as never,
      stubProvider,
      buildGraphProvider,
    );

    for (const fn of READ_QUERY_FNS) expect(functions.has(fn)).toBe(true);
    // Extraction-only provider construction stays gated even though the
    // read/query APIs register.
    expect(buildGraphProvider).not.toHaveBeenCalled();
  });

  it("keeps the extract function available while extraction is frozen", () => {
    process.env.GRAPH_EXTRACTION_ENABLED = "false";
    const { sdk, functions } = mockSdk();

    registerGraphFunctions(
      sdk as never,
      mockKV() as never,
      stubProvider,
      () => ({ provider: stubProvider, model: "m", baseModel: "m" }),
    );

    expect(functions.has("mem::graph-extract")).toBe(true);
  });

  it("builds the graph-specific provider and registers read/query when extraction is enabled", () => {
    process.env.GRAPH_EXTRACTION_ENABLED = "true";
    const { sdk, functions } = mockSdk();
    const buildGraphProvider = vi.fn(() => ({
      provider: stubProvider,
      model: "graph-model",
      baseModel: "base-model",
    }));

    registerGraphFunctions(
      sdk as never,
      mockKV() as never,
      stubProvider,
      buildGraphProvider,
    );

    expect(buildGraphProvider).toHaveBeenCalledTimes(1);
    for (const fn of READ_QUERY_FNS) expect(functions.has(fn)).toBe(true);
    expect(functions.has("mem::graph-extract")).toBe(true);
  });

  it("treats a malformed GRAPH_EXTRACTION_ENABLED value as false but still registers read/query (MALFORMED INPUT)", () => {
    process.env.GRAPH_EXTRACTION_ENABLED = "TRUE";
    const { sdk, functions } = mockSdk();
    const buildGraphProvider = vi.fn(() => ({
      provider: stubProvider,
      model: "m",
      baseModel: "m",
    }));

    registerGraphFunctions(
      sdk as never,
      mockKV() as never,
      stubProvider,
      buildGraphProvider,
    );

    expect(buildGraphProvider).not.toHaveBeenCalled();
    for (const fn of READ_QUERY_FNS) expect(functions.has(fn)).toBe(true);
  });
});
