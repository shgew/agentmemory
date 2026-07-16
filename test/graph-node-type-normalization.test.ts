import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerGraphFunction,
  normalizeGraphNodeType,
} from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import { SNAPSHOT_KEY } from "../src/state/graph-snapshot.js";
import type {
  CompressedObservation,
  GraphNode,
  GraphSnapshot,
} from "../src/types.js";

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
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

let xmlResponse = "";
const provider = {
  name: "test",
  compress: vi.fn(async () => xmlResponse),
  summarize: vi.fn(),
};

const obs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "other",
  title: "t",
  facts: [],
  narrative: "n",
  concepts: [],
  files: [],
  importance: 5,
};

describe("graph node-type normalization", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerGraphFunction(sdk as never, kv as never, provider as never);
  });

  it("recovers entities with malformed types by trimming + typo-correcting at write time", async () => {
    xmlResponse = `<entities>
<entity type=" file" name="foo.ts"/>
<entity type="decison" name="use jwt"/>
<entity type="Function" name="main"/>
</entities>`;

    await sdk.trigger("mem::graph-extract", { observations: [obs] });
    const stats = (await sdk.trigger("mem::graph-stats", {})) as {
      totalNodes: number;
      nodesByType: Record<string, number>;
    };

    // All three recovered: ' file' -> file, decison -> decision,
    // Function -> function.
    expect(stats.totalNodes).toBe(3);
    expect(stats.nodesByType).toEqual({
      file: 1,
      decision: 1,
      function: 1,
    });
  });

  it("drops types that cannot be salvaged (empty / whitespace-only) [MALFORMED INPUT]", async () => {
    xmlResponse = `<entities>
<entity type="" name="empty"/>
<entity type="   " name="blank"/>
<entity type="file" name="real.ts"/>
</entities>`;

    await sdk.trigger("mem::graph-extract", { observations: [obs] });
    const stats = (await sdk.trigger("mem::graph-stats", {})) as {
      totalNodes: number;
      nodesByType: Record<string, number>;
    };

    expect(stats.totalNodes).toBe(1);
    expect(stats.nodesByType).toEqual({ file: 1 });
  });

  it("normalizeGraphNodeType trims, lowercases, and typo-corrects; rejects empty", () => {
    expect(normalizeGraphNodeType(" file")).toBe("file");
    expect(normalizeGraphNodeType("decison")).toBe("decision");
    expect(normalizeGraphNodeType("Function")).toBe("function");
    expect(normalizeGraphNodeType("  DECISION ")).toBe("decision");
    expect(normalizeGraphNodeType("")).toBeUndefined();
    expect(normalizeGraphNodeType("   ")).toBeUndefined();
    expect(normalizeGraphNodeType(42)).toBeUndefined();
    expect(normalizeGraphNodeType("concept")).toBe("concept");
  });

  it("mem::graph-normalize-types fixes stored malformed nodes + snapshot in place and is idempotent (STALE STATE)", async () => {
    // Seed legacy data: a stored node with a leading-space type, and a
    // snapshot whose stats + topNodes carry malformed type keys.
    const badNode: GraphNode = {
      id: "gn_bad",
      type: " file" as GraphNode["type"],
      name: "legacy.ts",
      properties: {},
      sourceObservationIds: ["obs_1"],
      createdAt: "2026-02-01T00:00:00Z",
    };
    const goodNode: GraphNode = {
      id: "gn_good",
      type: "file",
      name: "clean.ts",
      properties: {},
      sourceObservationIds: ["obs_1"],
      createdAt: "2026-02-01T00:00:00Z",
    };
    await kv.set(KV.graphNodes, badNode.id, badNode);
    await kv.set(KV.graphNodes, goodNode.id, goodNode);
    await kv.set(KV.graphNameIndex, " file|legacy.ts", badNode.id);
    const snap: GraphSnapshot = {
      version: 1,
      topNodes: [badNode, goodNode],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 5,
        totalEdges: 0,
        nodesByType: { " file": 2, decison: 1, file: 2 },
        edgesByType: {},
      },
      updatedAt: "2026-02-01T00:00:00Z",
      dirty: false,
    };
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);

    const first = (await sdk.trigger("mem::graph-normalize-types", {})) as {
      scanned: number;
      fixed: number;
      snapshotUpdated: boolean;
    };
    expect(first.fixed).toBe(1);
    expect(first.snapshotUpdated).toBe(true);

    const storedBad = (await kv.get(KV.graphNodes, "gn_bad")) as GraphNode;
    expect(storedBad.type).toBe("file");
    expect(await kv.get(KV.graphNameIndex, " file|legacy.ts")).toBeNull();
    expect(await kv.get(KV.graphNameIndex, "file|legacy.ts")).toBe("gn_bad");

    const after = (await sdk.trigger("mem::graph-stats", {})) as {
      nodesByType: Record<string, number>;
    };
    // ' file' (2) merges into file (2) -> 4; decison (1) -> decision (1).
    expect(after.nodesByType).toEqual({ file: 4, decision: 1 });

    // Idempotent: a second pass changes nothing.
    const second = (await sdk.trigger("mem::graph-normalize-types", {})) as {
      fixed: number;
      snapshotUpdated: boolean;
    };
    expect(second.fixed).toBe(0);
    expect(second.snapshotUpdated).toBe(false);

    xmlResponse = `<entities><entity type="file" name="legacy.ts"/></entities>`;
    await sdk.trigger("mem::graph-extract", { observations: [obs] });
    expect(await kv.list(KV.graphNodes)).toHaveLength(2);
  });

  it("fails closed when stored nodes cannot be enumerated", async () => {
    const originalList = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.graphNodes) throw new Error("state unavailable");
      return originalList<T>(scope);
    };

    const result = (await sdk.trigger("mem::graph-normalize-types", {})) as {
      success: boolean;
      fixed: number;
      error: string;
    };

    expect(result).toMatchObject({
      success: false,
      fixed: 0,
      error: "state unavailable",
    });
  });

  it("does not mutate rows, indexes, or snapshot copies during dry run", async () => {
    const malformed = {
      id: "gn_dry",
      type: " file" as GraphNode["type"],
      name: "dry.ts",
      properties: {},
      sourceObservationIds: ["obs_1"],
      createdAt: "2026-02-01T10:00:00Z",
    };
    const snapshot: GraphSnapshot = {
      version: 1,
      topNodes: [malformed],
      topEdges: [],
      topDegrees: { gn_dry: 0 },
      stats: {
        totalNodes: 1,
        totalEdges: 0,
        nodesByType: { " file": 1 },
        edgesByType: {},
      },
      updatedAt: "2026-02-01T10:00:00Z",
      dirty: false,
    };
    await kv.set(KV.graphNodes, malformed.id, malformed);
    await kv.set(KV.graphNameIndex, " file|dry.ts", malformed.id);
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snapshot);

    const result = (await sdk.trigger("mem::graph-normalize-types", {
      dryRun: true,
    })) as { success: boolean; fixed: number; snapshotUpdated: boolean };

    expect(result).toMatchObject({
      success: true,
      fixed: 1,
      snapshotUpdated: true,
    });
    expect(
      (await kv.get<GraphNode>(KV.graphNodes, malformed.id))?.type,
    ).toBe(" file");
    expect(await kv.get(KV.graphNameIndex, " file|dry.ts")).toBe(
      malformed.id,
    );
    expect(await kv.get(KV.graphNameIndex, "file|dry.ts")).toBeNull();
    expect(
      (await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY))?.topNodes[0]
        .type,
    ).toBe(" file");
  });
});
