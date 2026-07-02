import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphFunction } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphEdge } from "../src/types.js";

function mockKV(opts: { throwListScopes?: string[] } = {}) {
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
    list: async <T>(scope: string): Promise<T[]> => {
      if (opts.throwListScopes?.includes(scope)) {
        throw new Error(`forbidden kv.list on ${scope}`);
      }
      const e = store.get(scope);
      return e ? (Array.from(e.values()) as T[]) : [];
    },
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
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };

function node(
  id: string,
  type = "concept",
  name = id,
  sourceObservationIds: string[] = [],
): GraphNode {
  return {
    id,
    type: type as GraphNode["type"],
    name,
    properties: {},
    sourceObservationIds,
    createdAt: "2026-04-01T00:00:00Z",
  };
}

function edge(
  id: string,
  src: string,
  tgt: string,
  type = "related_to",
  sourceObservationIds: string[] = [],
): GraphEdge {
  return {
    id,
    type: type as GraphEdge["type"],
    sourceNodeId: src,
    targetNodeId: tgt,
    weight: 1,
    sourceObservationIds,
    createdAt: "2026-04-01T00:00:00Z",
  };
}

const nameKey = (type: string, name: string) => `${type}|${name}`;
const edgeKey = (src: string, tgt: string, type: string) => `${src}|${tgt}|${type}`;

function setup(kvOpts: { throwListScopes?: string[] } = {}) {
  const kv = mockKV(kvOpts);
  const sdk = mockSdk();
  registerGraphFunction(sdk as never, kv as never, provider as never);
  return { kv, sdk };
}

type KVLike = ReturnType<typeof mockKV>;
async function seedLiveObs(kv: KVLike, sid: string, obsId: string) {
  await kv.set(KV.sessions, sid, { id: sid });
  await kv.set(KV.observations(sid), obsId, { id: obsId });
}

type PruneResult = {
  success: boolean;
  seeded: number;
  skippedLive: number;
  skippedMissing: number;
  remainingCandidates: number;
  tombstoneQueueLen: number;
  refused?: boolean;
};

describe("mem::graph-prune-orphans", () => {
  it("seeds a tombstone for a true orphan node with correct indexKey and observedSourceCount", async () => {
    const { kv, sdk } = setup();
    await seedLiveObs(kv, "s1", "obsLive");
    await kv.set(
      KV.graphNodes,
      "gn_orphan",
      node("gn_orphan", "concept", "foo", ["obsGone"]),
    );

    const res = (await sdk.trigger("mem::graph-prune-orphans", {
      nodeIds: ["gn_orphan"],
    })) as PruneResult;

    expect(res.seeded).toBe(1);
    expect(res.skippedLive).toBe(0);
    expect(res.skippedMissing).toBe(0);
    const tomb = await kv.get(KV.graphTombstones, "gn_orphan");
    expect(tomb).toMatchObject({
      id: "gn_orphan",
      kind: "node",
      reason: "prune",
      indexKey: nameKey("concept", "foo"),
      observedSourceCount: 1,
    });
  });

  it("skips a node that still has a live source observation", async () => {
    const { kv, sdk } = setup();
    await seedLiveObs(kv, "s1", "obsLive");
    await kv.set(
      KV.graphNodes,
      "gn_live",
      node("gn_live", "concept", "bar", ["obsLive"]),
    );

    const res = (await sdk.trigger("mem::graph-prune-orphans", {
      nodeIds: ["gn_live"],
    })) as PruneResult;

    expect(res.seeded).toBe(0);
    expect(res.skippedLive).toBe(1);
    expect(await kv.get(KV.graphTombstones, "gn_live")).toBeNull();
  });

  it("skips a candidate whose row no longer exists", async () => {
    const { kv, sdk } = setup();
    await seedLiveObs(kv, "s1", "obsLive");

    const res = (await sdk.trigger("mem::graph-prune-orphans", {
      nodeIds: ["gn_ghost"],
    })) as PruneResult;

    expect(res.seeded).toBe(0);
    expect(res.skippedMissing).toBe(1);
  });

  it("seeds a tombstone for a true orphan edge with the edge indexKey", async () => {
    const { kv, sdk } = setup();
    await seedLiveObs(kv, "s1", "obsLive");
    await kv.set(
      KV.graphEdges,
      "ge_orphan",
      edge("ge_orphan", "a", "b", "related_to", ["obsGone"]),
    );

    const res = (await sdk.trigger("mem::graph-prune-orphans", {
      edgeIds: ["ge_orphan"],
    })) as PruneResult;

    expect(res.seeded).toBe(1);
    const tomb = await kv.get(KV.graphTombstones, "ge_orphan");
    expect(tomb).toMatchObject({
      id: "ge_orphan",
      kind: "edge",
      reason: "prune",
      indexKey: edgeKey("a", "b", "related_to"),
      observedSourceCount: 1,
    });
  });

  it("treats a live memory id as a live source and does not tombstone", async () => {
    const { kv, sdk } = setup();
    await kv.set(KV.memories, "mem_1", { id: "mem_1" });
    await kv.set(
      KV.graphNodes,
      "gn_memlinked",
      node("gn_memlinked", "concept", "baz", ["mem_1"]),
    );

    const res = (await sdk.trigger("mem::graph-prune-orphans", {
      nodeIds: ["gn_memlinked"],
    })) as PruneResult;

    expect(res.seeded).toBe(0);
    expect(res.skippedLive).toBe(1);
  });

  it("refuses to seed when the tombstone queue exceeds tombstoneCeiling", async () => {
    const { kv, sdk } = setup();
    for (let i = 0; i < 3; i++) {
      await kv.set(KV.graphTombstones, `t${i}`, {
        id: `t${i}`,
        kind: "node",
        reason: "prune",
        indexKey: "x",
        tombstonedAt: "2026-04-01T00:00:00Z",
      });
    }
    await kv.set(
      KV.graphNodes,
      "gn_orphan",
      node("gn_orphan", "concept", "foo", ["obsGone"]),
    );

    const res = (await sdk.trigger("mem::graph-prune-orphans", {
      nodeIds: ["gn_orphan"],
      tombstoneCeiling: 2,
    })) as PruneResult;

    expect(res.refused).toBe(true);
    expect(res.seeded).toBe(0);
    expect(await kv.get(KV.graphTombstones, "gn_orphan")).toBeNull();
  });

  it("never enumerates graphNodes or graphEdges (heartbeat-safe)", async () => {
    const { kv, sdk } = setup({
      throwListScopes: [KV.graphNodes, KV.graphEdges],
    });
    await seedLiveObs(kv, "s1", "obsLive");
    await kv.set(
      KV.graphNodes,
      "gn_orphan",
      node("gn_orphan", "concept", "foo", ["obsGone"]),
    );
    await kv.set(
      KV.graphEdges,
      "ge_orphan",
      edge("ge_orphan", "a", "b", "related_to", ["obsGone"]),
    );

    const res = (await sdk.trigger("mem::graph-prune-orphans", {
      nodeIds: ["gn_orphan"],
      edgeIds: ["ge_orphan"],
    })) as PruneResult;

    expect(res.seeded).toBe(2);
  });
});
