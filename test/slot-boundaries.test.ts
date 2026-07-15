import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { registerApiTriggers } from "../src/triggers/api.js";

declare const process: { env: Record<string, string | undefined> };
const env = process.env;

type Handler = (request: {
  body?: unknown;
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
}) => Promise<{ status_code: number; body: unknown }>;

type TriggerCall = {
  function_id: string;
  payload: unknown;
};

function mockRuntime() {
  const handlers = new Map<string, Handler>();
  const calls: TriggerCall[] = [];
  const sdk = {
    registerFunction: vi.fn((id: string, handler: Handler) => {
      handlers.set(id, handler);
    }),
    registerTrigger: vi.fn(),
    trigger: vi.fn(async (input: TriggerCall) => {
      calls.push(input);
      return { success: true };
    }),
  };
  const kv = {
    get: vi.fn(async () => null),
    set: vi.fn(async (_scope: string, _key: string, value: unknown) => value),
    update: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
  };
  return { sdk, kv, handlers, calls };
}

function handler(
  handlers: Map<string, Handler>,
  functionId: string,
): Handler {
  const registered = handlers.get(functionId);
  if (!registered) throw new Error(`missing handler: ${functionId}`);
  return registered;
}

describe("slot caller boundaries", () => {
  const originalSlots = env["AGENTMEMORY_SLOTS"];

  beforeEach(() => {
    env["AGENTMEMORY_SLOTS"] = "true";
  });

  afterEach(() => {
    if (originalSlots === undefined) delete env["AGENTMEMORY_SLOTS"];
    else env["AGENTMEMORY_SLOTS"] = originalSlots;
  });

  it("exposes project on every slot MCP schema and requires it for list", () => {
    const slotTools = getAllTools().filter((tool) =>
      tool.name.startsWith("memory_slot_"),
    );
    const list = slotTools.find((tool) => tool.name === "memory_slot_list");
    const get = slotTools.find((tool) => tool.name === "memory_slot_get");

    expect(slotTools).toHaveLength(6);
    expect(
      slotTools.every((tool) => tool.inputSchema.properties["project"]),
    ).toBe(true);
    expect(list?.inputSchema.required).toContain("project");
    expect(get?.inputSchema.properties["legacyUnscoped"]?.type).toBe(
      "boolean",
    );
  });

  it("threads project through the MCP slot replace handler", async () => {
    const runtime = mockRuntime();
    registerMcpEndpoints(runtime.sdk as never, runtime.kv as never);

    const result = await handler(runtime.handlers, "mcp::tools::call")({
      body: {
        name: "memory_slot_replace",
        arguments: {
          label: "pending_items",
          content: "next",
          project: "agentmemory",
        },
      },
    });

    expect(result.status_code).toBe(200);
    expect(runtime.calls).toContainEqual({
      function_id: "mem::slot-replace",
      payload: {
        label: "pending_items",
        content: "next",
        project: "agentmemory",
      },
    });
  });

  it("rejects an empty MCP project before triggering a slot write", async () => {
    const runtime = mockRuntime();
    registerMcpEndpoints(runtime.sdk as never, runtime.kv as never);

    const result = await handler(runtime.handlers, "mcp::tools::call")({
      body: {
        name: "memory_slot_replace",
        arguments: {
          label: "pending_items",
          content: "next",
          project: " ",
        },
      },
    });

    expect(result.status_code).toBe(400);
    expect(runtime.calls).toHaveLength(0);
  });

  it("threads project through the REST slot list route", async () => {
    const runtime = mockRuntime();
    registerApiTriggers(runtime.sdk as never, runtime.kv as never);

    const result = await handler(runtime.handlers, "api::slot-list")({
      query_params: { project: "agentmemory" },
    });

    expect(result.status_code).toBe(200);
    expect(runtime.calls).toContainEqual({
      function_id: "mem::slot-list",
      payload: { project: "agentmemory" },
    });
  });

  it("rejects a REST project slot create without project", async () => {
    const runtime = mockRuntime();
    registerApiTriggers(runtime.sdk as never, runtime.kv as never);

    const result = await handler(runtime.handlers, "api::slot-create")({
      body: { label: "custom" },
    });

    expect(result.status_code).toBe(400);
    expect(runtime.calls).toHaveLength(0);
  });

  it("keeps REST global slot creation project-free", async () => {
    const runtime = mockRuntime();
    registerApiTriggers(runtime.sdk as never, runtime.kv as never);

    const result = await handler(runtime.handlers, "api::slot-create")({
      body: { label: "global_custom", scope: "global" },
    });

    expect(result.status_code).toBe(201);
    expect(runtime.calls).toContainEqual({
      function_id: "mem::slot-create",
      payload: { label: "global_custom", scope: "global" },
    });
  });
});
