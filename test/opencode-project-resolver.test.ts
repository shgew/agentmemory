import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentmemoryCapturePlugin } from "../plugin/opencode/agentmemory-capture";
import { RESOLVER_SCENARIOS } from "./_fixtures/project-resolver-scenarios.js";

type PluginInstance = Awaited<ReturnType<typeof AgentmemoryCapturePlugin>>;

const FAKE_CTX = {
  worktree: undefined,
  project: { id: "some-uuid" },
  client: undefined,
  directory: "/tmp/test-worktree",
  $: undefined,
} as any;

type PostCall = { url: string; body: any };

function installFetchMock(): PostCall[] {
  const calls: PostCall[] = [];
  const fakeFetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? "";
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    let parsed: any = null;
    try { parsed = bodyStr ? JSON.parse(bodyStr) : null; } catch {}
    calls.push({ url, body: parsed });
    return {
      ok: true,
      status: 200,
      json: async () => ({ context: "<test-context>" }),
    } as any;
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
        event: { type: "session.created", properties: { info: { id: "s_project_resolver", title: "T", parentID: null, version: "1" } } } as any,
      });

      const start = findPost(calls, "/session/start");
      expect(start).toBeDefined();
      expect(start!.body.project).toBe(scenario.expected);
    } finally {
      scenario.cleanup?.();
    }
  });
});
