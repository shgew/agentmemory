import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";
import type { GraphQueryResult } from "../src/types.js";

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
    trigger: async (input: { function_id: string; payload: unknown }) => {
      const fn = functions.get(input.function_id);
      if (!fn) throw new Error(`No function: ${input.function_id}`);
      return fn(input.payload);
    },
  };
  return { sdk, functions };
}

function fullGraphResult(): GraphQueryResult {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) properties[`k${i}`] = `v${i}`;
  return {
    nodes: [
      {
        id: "n1",
        type: "file",
        name: "x",
        sourceObservationIds: ["a", "b", "c"],
        properties,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    edges: [
      {
        id: "e1",
        type: "uses",
        sourceNodeId: "n1",
        targetNodeId: "n2",
        weight: 0.9,
        sourceObservationIds: ["x", "y"],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    depth: 1,
  };
}

async function callGraphQuery(args: Record<string, unknown>) {
  const { sdk, functions } = mockSdk();
  let captured: any;
  sdk.registerFunction("mem::graph-query", async (payload: any) => {
    captured = payload;
    return fullGraphResult();
  });
  registerMcpEndpoints(sdk as any, mockKV() as any, undefined);
  const handler = functions.get("mcp::tools::call")!;
  const res: any = await handler({
    body: { name: "memory_graph_query", arguments: args },
  });
  return { captured, res };
}

describe("memory_graph_query MCP handler", () => {
  it("defaults limit to 50 when no limit arg is given", async () => {
    const { captured } = await callGraphQuery({});
    expect(captured.limit).toBe(50);
  });

  it("clamps an oversized limit down to 100", async () => {
    const { captured } = await callGraphQuery({ limit: 500 });
    expect(captured.limit).toBe(100);
  });

  it("passes offset through into the graph-query payload", async () => {
    const { captured } = await callGraphQuery({ offset: 5 });
    expect(captured.offset).toBe(5);
  });

  it("trims sourceObservationIds from nodes and edges in the returned text", async () => {
    const { res } = await callGraphQuery({});
    const parsed = JSON.parse(res.body.content[0].text);
    expect(parsed.nodes[0].sourceObservationCount).toBe(3);
    expect(parsed.nodes[0].sourceObservationIds).toBeUndefined();
    expect(parsed.edges[0].sourceObservationCount).toBe(2);
    expect(parsed.edges[0].sourceObservationIds).toBeUndefined();
  });
});
