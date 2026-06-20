import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentmemoryCapturePlugin } from "../plugin/opencode/agentmemory-capture";
import type { Event as EventV1 } from "@opencode-ai/sdk";
import type { Plugin } from "@opencode-ai/plugin";
import { RESOLVER_SCENARIOS } from "./_fixtures/project-resolver-scenarios.js";

type PluginInstance = Awaited<ReturnType<typeof AgentmemoryCapturePlugin>>;

type PluginCtx = Parameters<Plugin>[0];

const FAKE_CTX: PluginCtx = {
  worktree: undefined,
  project: { id: "some-uuid" },
  client: undefined,
  directory: "/tmp/test-worktree",
  $: undefined,
} as unknown as PluginCtx;

type PostCall = { url: string; body: Record<string, unknown> | null };

function installFetchMock(): PostCall[] {
  const calls: PostCall[] = [];
  const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url ?? "";
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    let parsed: Record<string, unknown> | null = null;
    try { parsed = bodyStr ? JSON.parse(bodyStr) as Record<string, unknown> : null; } catch {}
    calls.push({ url, body: parsed });
    return new Response(JSON.stringify({ context: "<test-context>" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fakeFetch);
  return calls;
}

let activePlugin: PluginInstance | null = null;
const originalCwd = process.cwd();
const originalEnv = process.env.AGENTMEMORY_PROJECT_NAME;

async function teardownPlugin(): Promise<void> {
  if (activePlugin?.dispose) {
    try { await activePlugin.dispose(); } catch {}
  }
  activePlugin = null;
  vi.unstubAllGlobals();
}

function findPost(calls: PostCall[], path: string): PostCall | undefined {
  return calls.find((c) => c.url.endsWith(`/agentmemory${path}`));
}

describe("opencode plugin project resolver", () => {
  beforeEach(() => {
    delete process.env.AGENTMEMORY_PROJECT_NAME;
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    await teardownPlugin();
    process.chdir(originalCwd);
    if (originalEnv === undefined) {
      delete process.env.AGENTMEMORY_PROJECT_NAME;
    } else {
      process.env.AGENTMEMORY_PROJECT_NAME = originalEnv;
    }
  });

  it.each(RESOLVER_SCENARIOS)("$name", async ({ setup }) => {
    const scenario = setup();
    if (scenario.envProjectName !== undefined) {
      process.env.AGENTMEMORY_PROJECT_NAME = scenario.envProjectName;
    }
    process.chdir(scenario.pluginCwd);

    try {
      const calls = installFetchMock();
      activePlugin = await AgentmemoryCapturePlugin(FAKE_CTX);
      await activePlugin.event!({
        event: { type: "session.created", properties: { info: { id: "s_project_resolver", title: "T", parentID: null, version: "1" } } } as EventV1,
      });

      const start = findPost(calls, "/session/start");
      expect(start).toBeDefined();
      expect(start!.body.project).toBe(scenario.expected);
    } finally {
      scenario.cleanup?.();
    }
  });
});
