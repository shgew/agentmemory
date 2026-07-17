import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerMcpEndpoints } from "../src/mcp/server.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

type Handler = (data: unknown) => unknown | Promise<unknown>;

function createHarness() {
  const functions = new Map<string, Handler>();
  const scopes = new Map<string, Map<string, unknown>>();
  const sdk = {
    registerFunction: (
      idOrOptions: string | { id: string },
      handler: Handler,
    ): void => {
      functions.set(
        typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id,
        handler,
      );
    },
    registerTrigger: (): void => {},
    trigger: vi.fn(async () => ({})),
  };
  const kv = {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (scopes.get(scope)?.get(key) as T) ?? null,
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(scopes.get(scope)?.values() ?? []) as T[],
  };
  const seed = (scope: string, key: string, value: unknown): void => {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    scopes.get(scope)?.set(key, value);
  };
  registerMcpEndpoints(sdk as never, kv as never);
  const call = functions.get("mcp::tools::call");
  if (!call) throw new Error("mcp::tools::call was not registered");
  const prompt = functions.get("mcp::prompts::get");
  if (!prompt) throw new Error("mcp::prompts::get was not registered");
  return { call, prompt, sdk, seed };
}

function request(name: string, args: Record<string, unknown>) {
  return { body: { name, arguments: args }, headers: {}, query_params: {} };
}

function parseContent(response: unknown): Record<string, unknown> {
  const body = (response as {
    body: { content: Array<{ text: string }> };
  }).body;
  return JSON.parse(body.content[0]?.text ?? "{}");
}

function session(id: string, agentId: string, parentSessionId?: string): Session {
  return {
    id,
    project: "project",
    cwd: "/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    observationCount: 0,
    agentId,
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

describe("MCP boundaries", () => {
  beforeEach(() => {
    vi.stubEnv("AGENT_ID", "");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "");
    vi.stubEnv("AGENTMEMORY_TOOLS", "all");
    vi.stubEnv("AGENTMEMORY_TOOLS_DISABLE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards project to recall and smart search", async () => {
    const { call, sdk } = createHarness();

    await call(request("memory_recall", { query: "auth", project: "ios" }));
    expect(sdk.trigger).toHaveBeenLastCalledWith({
      function_id: "mem::search",
      payload: expect.objectContaining({ project: "ios" }),
    });

    await call(
      request("memory_smart_search", { query: "auth", project: "ios" }),
    );
    expect(sdk.trigger).toHaveBeenLastCalledWith({
      function_id: "mem::smart-search",
      payload: expect.objectContaining({ project: "ios" }),
    });
  });

  it("rejects an invalid project instead of dropping the scope", async () => {
    const { call, sdk } = createHarness();

    const recall = (await call(
      request("memory_recall", { query: "auth", project: " " }),
    )) as { status_code: number };
    const smartSearch = (await call(
      request("memory_smart_search", { query: "auth", project: 42 }),
    )) as { status_code: number };

    expect(recall.status_code).toBe(400);
    expect(smartSearch.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects direct calls to disabled and hidden tools", async () => {
    const { call, sdk } = createHarness();
    vi.stubEnv("AGENTMEMORY_TOOLS_DISABLE", "memory_recall");

    const disabled = (await call(
      request("memory_recall", { query: "auth" }),
    )) as { status_code: number };
    expect(disabled.status_code).toBe(400);

    vi.stubEnv("AGENTMEMORY_TOOLS_DISABLE", "");
    vi.stubEnv("AGENTMEMORY_TOOLS", "core");
    const hidden = (await call(
      request("memory_commit_lookup", {
        sha: "abc123def456abc123def456abc123def456abcd",
      }),
    )) as { status_code: number };
    expect(hidden.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("filters sessions by server identity and excludes children by default", async () => {
    const { call, seed } = createHarness();
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    seed(KV.sessions, "a-root", session("a-root", "agent-a"));
    seed(KV.sessions, "a-child", session("a-child", "agent-a", "a-root"));
    seed(KV.sessions, "b-root", session("b-root", "agent-b"));

    const roots = parseContent(
      await call(request("memory_sessions", { agentId: "*" })),
    );
    expect((roots.sessions as Session[]).map((item) => item.id)).toEqual([
      "a-root",
    ]);

    const all = parseContent(
      await call(
        request("memory_sessions", {
          agentId: "agent-b",
          includeSubagents: true,
        }),
      ),
    );
    expect((all.sessions as Session[]).map((item) => item.id).sort()).toEqual([
      "a-child",
      "a-root",
    ]);
  });

  it("uses server identity for writes under isolation", async () => {
    const { call, sdk } = createHarness();
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");

    await call(
      request("memory_save", {
        content: "isolated memory",
        agentId: "agent-b",
      }),
    );

    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::remember",
      payload: expect.objectContaining({ agentId: "agent-a" }),
    });
  });

  it("rejects agent-scoped tools and prompts when isolated identity is missing", async () => {
    const { call, prompt, sdk, seed } = createHarness();
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    vi.stubEnv("AGENT_ID", "");
    seed(KV.sessions, "foreign", session("foreign", "agent-b"));

    const responses = await Promise.all([
      call(request("memory_recall", { query: "private" })),
      call(request("memory_smart_search", { query: "private" })),
      call(request("memory_sessions", {})),
      call(request("memory_save", { content: "private" })),
      prompt({
        body: {
          name: "recall_context",
          arguments: { task_description: "private" },
        },
        headers: {},
        query_params: {},
      }),
    ]);

    for (const response of responses) {
      expect(response).toEqual({
        status_code: 403,
        body: {
          error: "agent identity is required when agent scope is isolated",
        },
      });
    }
    expect(sdk.trigger).not.toHaveBeenCalled();
  });
});
