import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphFunction } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import { SNAPSHOT_KEY } from "../src/state/graph-snapshot.js";
import type {
  CompressedObservation,
  GraphNode,
  GraphSnapshot,
} from "../src/types.js";

// Clones on every get AND set so each reader receives a distinct object,
// faithfully modeling iii StateKV's SQLite serialize/deserialize. A mockKV
// that returned shared references would let two concurrent extracts mutate
// the same in-memory snapshot and mask the lost-update the lock must fix.
function cloningKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      const v = store.get(scope)?.get(key);
      return v === undefined ? null : (structuredClone(v) as T);
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, structuredClone(data));
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries
        ? (Array.from(entries.values()).map((v) => structuredClone(v)) as T[])
        : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload: unknown }) => {
      const fn = functions.get(input.function_id);
      if (!fn) throw new Error(`No function: ${input.function_id}`);
      return fn(input.payload);
    },
  };
}

function entitiesXml(names: string[]): string {
  const ents = names.map((n) => `<entity type="file" name="${n}"/>`).join("\n");
  return `<entities>\n${ents}\n</entities>\n<relationships>\n</relationships>`;
}

function obsFor(group: string): CompressedObservation {
  return {
    id: `obs_${group}`,
    sessionId: `ses_${group}`,
    timestamp: "2026-02-01T10:00:00Z",
    type: "file_edit",
    title: `Edit ${group}`,
    facts: [group],
    narrative: `MARKER_${group}`,
    concepts: [group],
    files: [`${group}.ts`],
    importance: 7,
  };
}

const groupA = ["A1", "A2", "A3", "A4", "A5"];
const groupB = ["B1", "B2", "B3", "B4", "B5"];

const mockProvider = {
  name: "test",
  compress: vi.fn(async (_sys: string, prompt: string) => {
    if (prompt.includes("MARKER_A")) return entitiesXml(groupA);
    if (prompt.includes("MARKER_B")) return entitiesXml(groupB);
    return entitiesXml([]);
  }),
  summarize: vi.fn(),
};

describe("graph-extract snapshot merge under concurrency", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof cloningKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = cloningKV();
    vi.clearAllMocks();
    registerGraphFunction(sdk as never, kv as never, mockProvider as never);
  });

  it("does not lose snapshot stats when two extracts run concurrently", async () => {
    await Promise.all([
      sdk.trigger({
        function_id: "mem::graph-extract",
        payload: { observations: [obsFor("A")] },
      }),
      sdk.trigger({
        function_id: "mem::graph-extract",
        payload: { observations: [obsFor("B")] },
      }),
    ]);

    const allNodes = await kv.list<GraphNode>(KV.graphNodes);
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);

    expect(allNodes.length).toBe(10);
    expect(snap?.stats.totalNodes).toBe(10);
    expect(snap?.topNodes.length).toBe(10);
  });
});
