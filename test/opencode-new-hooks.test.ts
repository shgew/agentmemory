/// <reference types="node" />
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AgentmemoryCapturePlugin } from "../plugin/opencode/agentmemory-capture";

const pluginSource = readFileSync(
  "plugin/opencode/agentmemory-capture.ts",
  "utf-8",
);

type PluginInstance = Awaited<ReturnType<typeof AgentmemoryCapturePlugin>>;

const FAKE_CTX = {
  worktree: "/tmp/test-worktree",
  project: { id: "/tmp/test-worktree" },
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

async function loadPlugin(): Promise<{ plugin: PluginInstance; calls: PostCall[] }> {
  const calls = installFetchMock();
  const plugin = await AgentmemoryCapturePlugin(FAKE_CTX);
  activePlugin = plugin;
  return { plugin, calls };
}

async function teardownPlugin(): Promise<void> {
  if (activePlugin?.dispose) {
    try { await activePlugin.dispose(); } catch {}
  }
  activePlugin = null;
  vi.unstubAllGlobals();
}

function findObserve(calls: PostCall[], hookType: string): PostCall | undefined {
  return calls.find((c) => c.url.endsWith("/agentmemory/observe") && c.body?.hookType === hookType);
}

async function createActiveSession(plugin: PluginInstance, calls: PostCall[], sessionID: string): Promise<void> {
  await plugin.event!({
    event: { type: "session.created", properties: { info: { id: sessionID } } } as any,
  });
  calls.length = 0;
}

describe("OpenCode plugin: tool.execute.after typed hook", () => {
  it("registers a tool.execute.after handler", () => {
    expect(pluginSource).toMatch(/["']tool\.execute\.after["']\s*:\s*async/);
  });

  it("emits post_tool_use from tool.execute.after", () => {
    const start = pluginSource.indexOf('"tool.execute.after":');
    expect(start).toBeGreaterThan(-1);
    const block = pluginSource.slice(start, start + 1200);
    expect(block).toMatch(/observe\(\s*sid\s*,\s*["']post_tool_use["']/);
  });

  it("shares toolCallSetFor dedup with the message.part.updated tool branch", () => {
    const start = pluginSource.indexOf('"tool.execute.after":');
    const block = pluginSource.slice(start, start + 1200);
    expect(block).toMatch(/toolCallSetFor\(sid\)/);
  });
});

describe("OpenCode plugin: dispose cleanup hook", () => {
  it("registers a dispose handler", () => {
    expect(pluginSource).toMatch(/\bdispose\s*:\s*async/);
  });

  it("clears all session-scoped maps on dispose", () => {
    const start = pluginSource.indexOf("dispose:");
    expect(start).toBeGreaterThan(-1);
    const block = pluginSource.slice(start, start + 800);
    expect(block).toMatch(/stashedFiles\.clear\(\)/);
    expect(block).toMatch(/seenSubtaskIds\.clear\(\)/);
    expect(block).toMatch(/seenToolCallIds\.clear\(\)/);
    expect(block).toMatch(/contextInjectedSessions\.clear\(\)/);
    expect(block).toMatch(/startContextCache\.clear\(\)/);
  });

  it("does NOT post /session/end on dispose (plugin reload, not session end)", () => {
    const start = pluginSource.indexOf("dispose:");
    const end = pluginSource.indexOf("// ── config ──", start);
    const block = pluginSource.slice(start, end > start ? end : start + 800);
    expect(block).not.toMatch(/post\(\s*["']\/session\/end["']/);
  });
});

describe("OpenCode plugin: experimental.chat.messages.transform observer", () => {
  it("registers the messages.transform handler", () => {
    expect(pluginSource).toMatch(/["']experimental\.chat\.messages\.transform["']\s*:\s*async/);
  });

  it("emits a messages_transform observation", () => {
    const start = pluginSource.indexOf('"experimental.chat.messages.transform":');
    expect(start).toBeGreaterThan(-1);
    const block = pluginSource.slice(start, start + 600);
    expect(block).toMatch(/observe\(\s*sid\s*,\s*["']messages_transform["']/);
  });
});

describe("OpenCode plugin: command.execute.before typed hook", () => {
  it("registers the command.execute.before handler", () => {
    expect(pluginSource).toMatch(/["']command\.execute\.before["']\s*:\s*async/);
  });

  it("emits a command_before observation with command name", () => {
    const start = pluginSource.indexOf('"command.execute.before":');
    expect(start).toBeGreaterThan(-1);
    const block = pluginSource.slice(start, start + 600);
    expect(block).toMatch(/observe\(\s*sid\s*,\s*["']command_before["']/);
  });
});

describe("OpenCode plugin: permission.asked event", () => {
  it("handles permission.asked in the event switch", () => {
    expect(pluginSource).toMatch(/if\s*\(\s*event\.type\s*===\s*["']permission\.asked["']\s*\)/);
  });

  it("emits a permission_asked observation", () => {
    const idx = pluginSource.indexOf('if (event.type === "permission.asked")');
    expect(idx).toBeGreaterThan(-1);
    const block = pluginSource.slice(idx, idx + 800);
    expect(block).toMatch(/observe\(\s*sid\s*,\s*["']permission_asked["']/);
  });
});

describe("OpenCode plugin behavior: lsp.client.diagnostics", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures serverID and path when an active session exists", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_lsp");
    await plugin.event!({
      event: {
        type: "lsp.client.diagnostics",
        properties: { serverID: "tsserver", path: "src/index.ts" },
      } as any,
    });
    const observe = findObserve(calls, "lsp_diagnostics");
    expect(observe).toBeDefined();
    expect(observe!.body.sessionId).toBe("s_new_lsp");
    expect(observe!.body.data.serverID).toBe("tsserver");
    expect(observe!.body.data.path).toBe("src/index.ts");
  });

  it("does not observe without an active session", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "lsp.client.diagnostics",
        properties: { serverID: "tsserver", path: "src/index.ts" },
      } as any,
    });
    expect(findObserve(calls, "lsp_diagnostics")).toBeUndefined();
  });
});

describe("OpenCode plugin behavior: question.asked", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures the representative question prompt and tool identifiers", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_q1");
    await plugin.event!({
      event: {
        id: "evt-q1",
        type: "question.asked",
        properties: {
          id: "q-1",
          sessionID: "s_new_q1",
          questions: [
            { question: "Choose a deployment target", header: "Deploy", options: ["staging", "prod"] },
            { question: "Confirm", header: "Confirm", options: ["yes"] },
          ],
          tool: { messageID: "msg-q1", callID: "call-q1" },
        },
      } as any,
    });
    const observe = findObserve(calls, "question_asked");
    expect(observe).toBeDefined();
    expect(observe!.body.data.question_id).toBe("q-1");
    expect(observe!.body.data.questions).toBe(2);
    expect(observe!.body.data.header).toBe("Deploy");
    expect(observe!.body.data.prompt).toBe("Choose a deployment target");
    expect(observe!.body.data.tool_call_id).toBe("call-q1");
    expect(observe!.body.data.tool_message_id).toBe("msg-q1");
  });
});

describe("OpenCode plugin behavior: question.replied", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures requestID, answer_count, and flattened answers", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_q1r");
    await plugin.event!({
      event: {
        id: "evt-q1r",
        type: "question.replied",
        properties: {
          sessionID: "s_new_q1r",
          requestID: "req-q1r",
          answers: [["staging"], ["yes", "notify"]],
        },
      } as any,
    });
    const observe = findObserve(calls, "question_replied");
    expect(observe).toBeDefined();
    expect(observe!.body.data.request_id).toBe("req-q1r");
    expect(observe!.body.data.answer_count).toBe(2);
    expect(observe!.body.data.answers).toEqual(["staging", "yes", "notify"]);
  });
});

describe("OpenCode plugin behavior: question.rejected", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures requestID", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_q1x");
    await plugin.event!({
      event: {
        id: "evt-q1x",
        type: "question.rejected",
        properties: { sessionID: "s_new_q1x", requestID: "req-q1x" },
      } as any,
    });
    const observe = findObserve(calls, "question_rejected");
    expect(observe).toBeDefined();
    expect(observe!.body.data.request_id).toBe("req-q1x");
  });
});

describe("OpenCode plugin behavior: question.v2.asked", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures the representative question prompt and tool identifiers", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_q2");
    await plugin.event!({
      event: {
        id: "evt-q2",
        type: "question.v2.asked",
        properties: {
          id: "q-2",
          sessionID: "s_new_q2",
          questions: [
            { question: "Pick a model", header: "Model", options: ["fast", "smart"] },
          ],
          tool: { messageID: "msg-q2", callID: "call-q2" },
        },
      } as any,
    });
    const observe = findObserve(calls, "question_v2_asked");
    expect(observe).toBeDefined();
    expect(observe!.body.data.question_id).toBe("q-2");
    expect(observe!.body.data.questions).toBe(1);
    expect(observe!.body.data.header).toBe("Model");
    expect(observe!.body.data.prompt).toBe("Pick a model");
    expect(observe!.body.data.tool_call_id).toBe("call-q2");
    expect(observe!.body.data.tool_message_id).toBe("msg-q2");
  });
});

describe("OpenCode plugin behavior: question.v2.replied", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures requestID, answer_count, and flattened answers", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_q2r");
    await plugin.event!({
      event: {
        id: "evt-q2r",
        type: "question.v2.replied",
        properties: {
          sessionID: "s_new_q2r",
          requestID: "req-q2r",
          answers: [["fast"], ["confirm"]],
        },
      } as any,
    });
    const observe = findObserve(calls, "question_v2_replied");
    expect(observe).toBeDefined();
    expect(observe!.body.data.request_id).toBe("req-q2r");
    expect(observe!.body.data.answer_count).toBe(2);
    expect(observe!.body.data.answers).toEqual(["fast", "confirm"]);
  });
});

describe("OpenCode plugin behavior: question.v2.rejected", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures requestID", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_q2x");
    await plugin.event!({
      event: {
        id: "evt-q2x",
        type: "question.v2.rejected",
        properties: { sessionID: "s_new_q2x", requestID: "req-q2x" },
      } as any,
    });
    const observe = findObserve(calls, "question_v2_rejected");
    expect(observe).toBeDefined();
    expect(observe!.body.data.request_id).toBe("req-q2x");
  });
});

describe("OpenCode plugin behavior: mcp.tools.changed", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures server when an active session exists", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_mcp");
    await plugin.event!({
      event: {
        id: "evt-mcp",
        type: "mcp.tools.changed",
        properties: { server: "agentmemory" },
      } as any,
    });
    const observe = findObserve(calls, "mcp_tools_changed");
    expect(observe).toBeDefined();
    expect(observe!.body.sessionId).toBe("s_new_mcp");
    expect(observe!.body.data.server).toBe("agentmemory");
  });
});

describe("OpenCode plugin behavior: experimental.compaction.autocontinue", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures model and engine-default enabled=true without changing output", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_autocontinue");
    const output = { enabled: true } as any;
    await plugin["experimental.compaction.autocontinue"]!(
      {
        sessionID: "s_new_autocontinue",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.5" },
        provider: {},
        message: {},
        overflow: true,
      } as any,
      output,
    );
    const observe = findObserve(calls, "compaction_autocontinue");
    expect(observe).toBeDefined();
    expect(output.enabled).toBe(true);
    expect(observe!.body.data.agent).toBe("build");
    expect(observe!.body.data.model_id).toBe("openai/gpt-5.5");
    expect(observe!.body.data.overflow).toBe(true);
    expect(observe!.body.data.enabled).toBe(true);
  });

  it("leaves enabled=false untouched", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_autocontinue");
    const output = { enabled: false } as any;
    await plugin["experimental.compaction.autocontinue"]!(
      {
        sessionID: "s_new_autocontinue",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.5" },
        provider: {},
        message: {},
        overflow: false,
      } as any,
      output,
    );
    const observe = findObserve(calls, "compaction_autocontinue");
    expect(observe).toBeDefined();
    expect(output.enabled).toBe(false);
    expect(observe!.body.data.enabled).toBe(false);
    expect(observe!.body.data.overflow).toBe(false);
  });
});

describe("OpenCode plugin behavior: pty.created", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures pty info when an active session exists", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_pty_created");
    await plugin.event!({
      event: {
        type: "pty.created",
        properties: {
          info: {
            id: "pty-1",
            title: "build watch",
            command: "npm",
            args: ["run", "dev"],
            cwd: "/repo",
            status: "running",
            pid: 4242,
          },
        },
      } as any,
    });
    const observe = findObserve(calls, "pty_created");
    expect(observe).toBeDefined();
    expect(observe!.body.sessionId).toBe("s_new_pty_created");
    expect(observe!.body.data.pty_id).toBe("pty-1");
    expect(observe!.body.data.title).toBe("build watch");
    expect(observe!.body.data.command).toBe("npm");
    expect(observe!.body.data.args).toEqual(["run", "dev"]);
    expect(observe!.body.data.cwd).toBe("/repo");
    expect(observe!.body.data.status).toBe("running");
    expect(observe!.body.data.pid).toBe(4242);
  });

  it("does not observe without an active session", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "pty.created",
        properties: {
          info: { id: "pty-x", title: "x", command: "sh", args: [], cwd: "/", status: "running", pid: 1 },
        },
      } as any,
    });
    expect(findObserve(calls, "pty_created")).toBeUndefined();
  });
});

describe("OpenCode plugin behavior: pty.exited", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures pty id and exit code when an active session exists", async () => {
    const { plugin, calls } = await loadPlugin();
    await createActiveSession(plugin, calls, "s_new_pty_exited");
    await plugin.event!({
      event: {
        type: "pty.exited",
        properties: { id: "pty-1", exitCode: 137 },
      } as any,
    });
    const observe = findObserve(calls, "pty_exited");
    expect(observe).toBeDefined();
    expect(observe!.body.sessionId).toBe("s_new_pty_exited");
    expect(observe!.body.data.pty_id).toBe("pty-1");
    expect(observe!.body.data.exit_code).toBe(137);
  });

  it("does not observe without an active session", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "pty.exited",
        properties: { id: "pty-x", exitCode: 0 },
      } as any,
    });
    expect(findObserve(calls, "pty_exited")).toBeUndefined();
  });
});
