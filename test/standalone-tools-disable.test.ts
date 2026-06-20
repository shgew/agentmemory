import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { handleToolsList } from "../src/mcp/standalone.js";
import { resetHandleForTests } from "../src/mcp/rest-proxy.js";

type FetchMock = ReturnType<typeof vi.fn>;

function installFetch(handler: (url: string, init?: RequestInit) => Response): FetchMock {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(url.toString(), init),
  );
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

const BASE = "http://localhost:3111";

function fullToolsResponse() {
  return {
    tools: [
      { name: "memory_save", description: "save", inputSchema: { type: "object", properties: {} } },
      { name: "memory_recall", description: "recall", inputSchema: { type: "object", properties: {} } },
      { name: "memory_smart_search", description: "search", inputSchema: { type: "object", properties: {} } },
      { name: "memory_vision_search", description: "vision", inputSchema: { type: "object", properties: {} } },
      { name: "memory_team_share", description: "team", inputSchema: { type: "object", properties: {} } },
      { name: "memory_obsidian_export", description: "obsidian", inputSchema: { type: "object", properties: {} } },
      { name: "memory_mesh_sync", description: "mesh", inputSchema: { type: "object", properties: {} } },
      { name: "memory_compress_file", description: "compress", inputSchema: { type: "object", properties: {} } },
    ],
  };
}

describe("standalone bridge: AGENTMEMORY_TOOLS_DISABLE proxy filter (#blocker)", () => {
  const originalFetch = globalThis.fetch;
  const originalDisable = process.env["AGENTMEMORY_TOOLS_DISABLE"];

  beforeEach(() => {
    resetHandleForTests();
    process.env["AGENTMEMORY_URL"] = BASE;
    delete process.env["AGENTMEMORY_SECRET"];
    delete process.env["AGENTMEMORY_TOOLS_DISABLE"];
  });

  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
    if (originalDisable === undefined) delete process.env["AGENTMEMORY_TOOLS_DISABLE"];
    else process.env["AGENTMEMORY_TOOLS_DISABLE"] = originalDisable;
  });

  it("returns server tools verbatim when AGENTMEMORY_TOOLS_DISABLE is unset", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/mcp/tools")) {
        return new Response(JSON.stringify(fullToolsResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await handleToolsList();
    const tools = result.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(8);
    expect(tools.map((t) => t.name)).toContain("memory_vision_search");
    expect(tools.map((t) => t.name)).toContain("memory_obsidian_export");
  });

  it("drops named tools from proxy response when env is set", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/mcp/tools")) {
        return new Response(JSON.stringify(fullToolsResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    process.env["AGENTMEMORY_TOOLS_DISABLE"] =
      "memory_vision_search,memory_team_share,memory_obsidian_export";

    const result = await handleToolsList();
    const tools = result.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "memory_compress_file",
      "memory_mesh_sync",
      "memory_recall",
      "memory_save",
      "memory_smart_search",
    ]);
    expect(names).not.toContain("memory_vision_search");
    expect(names).not.toContain("memory_team_share");
    expect(names).not.toContain("memory_obsidian_export");
  });

  it("accepts whitespace- or newline-separated tool names", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/mcp/tools")) {
        return new Response(JSON.stringify(fullToolsResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    process.env["AGENTMEMORY_TOOLS_DISABLE"] = "memory_vision_search   memory_team_share\nmemory_mesh_sync";

    const result = await handleToolsList();
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("memory_vision_search");
    expect(names).not.toContain("memory_team_share");
    expect(names).not.toContain("memory_mesh_sync");
    expect(names).toHaveLength(5);
  });

  it("silently ignores unknown tool names", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/mcp/tools")) {
        return new Response(JSON.stringify(fullToolsResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    process.env["AGENTMEMORY_TOOLS_DISABLE"] = "memory_does_not_exist,memory_vision_search,another_phantom";

    const result = await handleToolsList();
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toHaveLength(7);
    expect(names).not.toContain("memory_vision_search");
  });

  it("keeps malformed entries (missing .name) for forward compatibility", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/mcp/tools")) {
        return new Response(
          JSON.stringify({
            tools: [
              { name: "memory_save", description: "s", inputSchema: {} },
              { description: "no name", inputSchema: {} },
              null,
              { name: "memory_vision_search", description: "v", inputSchema: {} },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    process.env["AGENTMEMORY_TOOLS_DISABLE"] = "memory_vision_search";

    const result = await handleToolsList();
    expect(result.tools).toHaveLength(3);
    expect((result.tools as Array<{ name?: string }>).map((t) => t?.name)).toEqual([
      "memory_save",
      undefined,
      undefined,
    ]);
  });

  it("applies the filter to the local fallback path when server is unreachable", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    process.env["AGENTMEMORY_TOOLS_DISABLE"] = "memory_save,memory_export";

    const result = await handleToolsList();
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).not.toContain("memory_save");
    expect(names).not.toContain("memory_export");
    expect(names.length).toBe(5);
    expect(names).toContain("memory_recall");
  });
});
