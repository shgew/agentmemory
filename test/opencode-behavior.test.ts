import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AgentmemoryCapturePlugin } from "../plugin/opencode/agentmemory-capture";

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
    try { parsed = bodyStr ? JSON.parse(bodyStr) : null; } catch { /* swallow */ }
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
    try { await activePlugin.dispose(); } catch { /* tolerate */ }
  }
  activePlugin = null;
  vi.unstubAllGlobals();
}

describe("OpenCode plugin behavior: command.execute.before payload", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("posts /observe with command + arguments from input (not output.arguments)", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin["command.execute.before"]!(
      { command: "deploy", sessionID: "s1", arguments: "--env=prod --force" } as any,
      { parts: [] } as any,
    );
    const observe = calls.find((c) => c.url.endsWith("/agentmemory/observe"));
    expect(observe).toBeDefined();
    expect(observe!.body.hookType).toBe("command_before");
    expect(observe!.body.data.command).toBe("deploy");
    expect(observe!.body.data.arguments).toBe("--env=prod --force");
  });
});

describe("OpenCode plugin behavior: tool.execute.after payload", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("posts /observe with tool name, callID, args, sanitized output", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin["tool.execute.after"]!(
      { tool: "Read", sessionID: "s2", callID: "call-1", args: { filePath: "/tmp/x.txt" } } as any,
      { output: "file contents here", title: "Read /tmp/x.txt", metadata: { size: 42 } } as any,
    );
    const observe = calls.find((c) => c.url.endsWith("/agentmemory/observe"));
    expect(observe).toBeDefined();
    expect(observe!.body.hookType).toBe("post_tool_use");
    expect(observe!.body.data.tool_name).toBe("Read");
    expect(observe!.body.data.call_id).toBe("call-1");
    expect(observe!.body.data.tool_output).toContain("file contents here");
    expect(observe!.body.data.title).toBe("Read /tmp/x.txt");
  });

  it("strips long base64 PNG output", async () => {
    const { plugin, calls } = await loadPlugin();
    const png = "iVBORw0KGgo" + "A".repeat(500);
    await plugin["tool.execute.after"]!(
      { tool: "Screenshot", sessionID: "s2", callID: "call-2", args: {} } as any,
      { output: png, title: "shot", metadata: {} } as any,
    );
    const observe = calls.find((c) => c.url.endsWith("/agentmemory/observe"));
    expect(observe!.body.data.tool_output).toMatch(/<base64:stripped:/);
  });

  it("dedupes against repeated callID", async () => {
    const { plugin, calls } = await loadPlugin();
    const input = { tool: "Read", sessionID: "s3", callID: "dup-call", args: {} } as any;
    const output = { output: "out", title: "t", metadata: {} } as any;
    await plugin["tool.execute.after"]!(input, output);
    await plugin["tool.execute.after"]!(input, output);
    const observeCalls = calls.filter((c) => c.url.endsWith("/agentmemory/observe") && c.body.data?.call_id === "dup-call");
    expect(observeCalls.length).toBe(1);
  });
});

describe("OpenCode plugin behavior: sanitizeOutput recurses into nested structures", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("strips base64 nested inside an object property", async () => {
    const { plugin, calls } = await loadPlugin();
    const longBase64 = "iVBORw0KGgo" + "A".repeat(500);
    await plugin["tool.execute.after"]!(
      { tool: "Screenshot", sessionID: "s-nested-1", callID: "n1", args: {} } as any,
      { output: { image: { data: longBase64, mime: "image/png" } }, title: "shot", metadata: {} } as any,
    );
    const observe = calls.find((c) => c.url.endsWith("/agentmemory/observe") && c.body.data?.call_id === "n1");
    expect(observe).toBeDefined();
    expect(observe!.body.data.tool_output).toMatch(/<base64:stripped:/);
    expect(observe!.body.data.tool_output).not.toMatch(/iVBORw0KGgoAAAAA/);
  });

  it("strips base64 inside an array of objects", async () => {
    const { plugin, calls } = await loadPlugin();
    const longBase64 = "/9j/" + "B".repeat(500);
    await plugin["tool.execute.after"]!(
      { tool: "MultiScreenshot", sessionID: "s-nested-2", callID: "n2", args: {} } as any,
      { output: { images: [{ data: longBase64 }, { data: longBase64 }] }, title: "shot", metadata: {} } as any,
    );
    const observe = calls.find((c) => c.url.endsWith("/agentmemory/observe") && c.body.data?.call_id === "n2");
    expect(observe).toBeDefined();
    const matches = observe!.body.data.tool_output.match(/<base64:stripped:\d+b>/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("strips base64 at depth 4", async () => {
    const { plugin, calls } = await loadPlugin();
    const longBase64 = "R0lGOD" + "D".repeat(500);
    const deep = { a: { b: { c: { png: longBase64 } } } };
    await plugin["tool.execute.after"]!(
      { tool: "Deep", sessionID: "s-deep", callID: "deep-1", args: {} } as any,
      { output: deep, title: "t", metadata: {} } as any,
    );
    const observe = calls.find((c) => c.url.endsWith("/agentmemory/observe") && c.body.data?.call_id === "deep-1");
    expect(observe!.body.data.tool_output).toMatch(/<base64:stripped:/);
  });

  it("survives circular references without throwing", async () => {
    const { plugin, calls } = await loadPlugin();
    const longBase64 = "iVBORw0KGgo" + "C".repeat(500);
    const circ: any = { label: longBase64 };
    circ.self = circ;
    await plugin["tool.execute.after"]!(
      { tool: "Weird", sessionID: "s-circ", callID: "circ-1", args: {} } as any,
      { output: circ, title: "t", metadata: {} } as any,
    );
    const observe = calls.find((c) => c.url.endsWith("/agentmemory/observe") && c.body.data?.call_id === "circ-1");
    expect(observe).toBeDefined();
    expect(observe!.body.data.tool_output).toMatch(/<base64:stripped:/);
  });

  it("strips data: URLs inside a nested object", async () => {
    const { plugin, calls } = await loadPlugin();
    const dataUrl = "data:image/png;base64," + "A".repeat(500);
    await plugin["tool.execute.after"]!(
      { tool: "Preview", sessionID: "s-dataurl", callID: "dataurl-1", args: {} } as any,
      { output: { preview: { src: dataUrl } }, title: "t", metadata: {} } as any,
    );
    const observe = calls.find((c) => c.url.endsWith("/agentmemory/observe") && c.body.data?.call_id === "dataurl-1");
    expect(observe!.body.data.tool_output).toMatch(/<blob:stripped:/);
  });
});

describe("OpenCode plugin behavior: permission.asked v2 payload", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures id, permission, patterns, always, tool.callID per v2 shape", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "permission.asked",
        properties: {
          id: "perm-123",
          sessionID: "s4",
          permission: "Bash",
          patterns: ["npm *", "git *"],
          always: ["pnpm *"],
          tool: { messageID: "msg-1", callID: "call-3" },
          metadata: { reason: "needs network" },
        },
      } as any,
    });
    const observe = calls.find((c) => c.url.endsWith("/agentmemory/observe") && c.body?.hookType === "permission_asked");
    expect(observe).toBeDefined();
    expect(observe!.body.data.permission_id).toBe("perm-123");
    expect(observe!.body.data.permission).toBe("Bash");
    expect(observe!.body.data.patterns).toEqual(["npm *", "git *"]);
    expect(observe!.body.data.always).toEqual(["pnpm *"]);
    expect(observe!.body.data.tool_call_id).toBe("call-3");
    expect(observe!.body.data.tool_message_id).toBe("msg-1");
  });
});

describe("OpenCode plugin behavior: permission.v2 events", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures permission.v2.asked with action + resources", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "permission.v2.asked",
        properties: {
          id: "v2-perm-1",
          sessionID: "s5",
          action: "read",
          resources: ["/secrets/api-key"],
          save: ["always"],
          metadata: {},
        },
      } as any,
    });
    const observe = calls.find((c) => c.body?.hookType === "permission_v2_asked");
    expect(observe).toBeDefined();
    expect(observe!.body.data.action).toBe("read");
    expect(observe!.body.data.resources).toEqual(["/secrets/api-key"]);
  });

  it("captures permission.v2.replied with reply", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "permission.v2.replied",
        properties: { sessionID: "s5", requestID: "req-1", reply: "allow" },
      } as any,
    });
    const observe = calls.find((c) => c.body?.hookType === "permission_v2_replied");
    expect(observe).toBeDefined();
    expect(observe!.body.data.request_id).toBe("req-1");
    expect(observe!.body.data.reply).toBe("allow");
  });
});

describe("OpenCode plugin behavior: message.part.removed", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures sessionID, messageID, partID", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "message.part.removed",
        properties: { sessionID: "s6", messageID: "msg-2", partID: "part-3" },
      } as any,
    });
    const observe = calls.find((c) => c.body?.hookType === "message_part_removed");
    expect(observe).toBeDefined();
    expect(observe!.body.data.messageID).toBe("msg-2");
    expect(observe!.body.data.partID).toBe("part-3");
  });
});

describe("OpenCode plugin behavior: file.watcher.updated", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures external fs changes when an active session exists", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s7" } } } as any,
    });
    calls.length = 0;
    await plugin.event!({
      event: {
        type: "file.watcher.updated",
        properties: { file: "/tmp/changed.ts", event: "change" },
      } as any,
    });
    const observe = calls.find((c) => c.body?.hookType === "file_watcher");
    expect(observe).toBeDefined();
    expect(observe!.body.data.file).toBe("/tmp/changed.ts");
    expect(observe!.body.data.event).toBe("change");
  });
});

describe("OpenCode plugin behavior: session.status is the canonical idle signal", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("fires /session/checkpoint on session.status with type=idle", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "session.status",
        properties: { sessionID: "s8", status: { type: "idle" } },
      } as any,
    });
    const checkpoint = calls.find((c) => c.url.endsWith("/agentmemory/session/checkpoint"));
    expect(checkpoint).toBeDefined();
  });

  it("does NOT fire /session/checkpoint on session.status with type=busy", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "session.status",
        properties: { sessionID: "s8b", status: { type: "busy" } },
      } as any,
    });
    const checkpoint = calls.find((c) => c.url.endsWith("/agentmemory/session/checkpoint"));
    expect(checkpoint).toBeUndefined();
  });

  it("ignores the deprecated session.idle event (server-side debounce handles late v1 emissions)", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID: "s9" } } as any,
    });
    const checkpoints = calls.filter((c) => c.url.endsWith("/agentmemory/session/checkpoint"));
    expect(checkpoints.length).toBe(0);
  });

  it("fires /session/checkpoint on every session.status idle (server applies the 10-min debounce)", async () => {
    const { plugin, calls } = await loadPlugin();
    const evt = {
      event: {
        type: "session.status",
        properties: { sessionID: "s9b", status: { type: "idle" } },
      } as any,
    };
    await plugin.event!(evt);
    await plugin.event!(evt);
    const checkpoints = calls.filter((c) => c.url.endsWith("/agentmemory/session/checkpoint"));
    expect(checkpoints.length).toBe(2);
  });
});

describe("OpenCode plugin behavior: vcs.branch.updated", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("captures the current branch when an active session exists", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s-vcs" } } } as any,
    });
    calls.length = 0;
    await plugin.event!({
      event: { type: "vcs.branch.updated", properties: { branch: "feature/oauth" } } as any,
    });
    const observe = calls.find((c) => c.body?.hookType === "vcs_branch_updated");
    expect(observe).toBeDefined();
    expect(observe!.body.data.branch).toBe("feature/oauth");
  });

  it("no-ops when no active session is tracked", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "vcs.branch.updated", properties: { branch: "main" } } as any,
    });
    const observe = calls.find((c) => c.body?.hookType === "vcs_branch_updated");
    expect(observe).toBeUndefined();
  });
});

describe("OpenCode plugin behavior: dispose does NOT end session", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("dispose clears maps without posting /session/end", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s10" } } } as any,
    });
    calls.length = 0;
    await plugin.dispose!();
    const sessionEnd = calls.find((c) => c.url.endsWith("/agentmemory/session/end"));
    expect(sessionEnd).toBeUndefined();
  });
});

describe("OpenCode plugin behavior: resumed-session re-injection", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("session.updated for unseen sid posts /session/start with resumed: true", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "session.updated",
        properties: { info: { id: "resumed-1", title: "old session" } },
      } as any,
    });
    const resumeStart = calls.find(
      (c) => c.url.endsWith("/agentmemory/session/start") && c.body?.resumed === true,
    );
    expect(resumeStart).toBeDefined();
    expect(resumeStart!.body.sessionId).toBe("resumed-1");
  });

  it("session.updated after session.created does NOT trigger resume", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "fresh-1" } } } as any,
    });
    calls.length = 0;
    await plugin.event!({
      event: { type: "session.updated", properties: { info: { id: "fresh-1" } } } as any,
    });
    const resumeStart = calls.find(
      (c) => c.url.endsWith("/agentmemory/session/start") && c.body?.resumed === true,
    );
    expect(resumeStart).toBeUndefined();
  });
});

describe("OpenCode plugin behavior: instruction block removed, slot doctrine deferred to AGENTS.md (P1)", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("first system.transform injection no longer embeds the hardcoded slot-tool instruction block", async () => {
    const { plugin } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s-p1" } } } as any,
    });
    const out = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]!(
      { sessionID: "s-p1" } as any,
      out as any,
    );
    const injected = out.system.join("\n");
    expect(injected).not.toMatch(/<agentmemory-instructions>/);
    expect(injected).not.toMatch(/memory_slot_list/);
  });
});

describe("OpenCode plugin behavior: re-injects memory context after compaction (P4)", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("session.compacted clears the injected flag so the next transform re-injects", async () => {
    const { plugin } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s-p4" } } } as any,
    });

    const out1 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]!(
      { sessionID: "s-p4" } as any,
      out1 as any,
    );
    expect(out1.system.length).toBeGreaterThan(0);

    const out2 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]!(
      { sessionID: "s-p4" } as any,
      out2 as any,
    );
    expect(out2.system.length).toBe(0);

    await plugin.event!({
      event: { type: "session.compacted", properties: { sessionID: "s-p4" } } as any,
    });

    const out3 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]!(
      { sessionID: "s-p4" } as any,
      out3 as any,
    );
    expect(out3.system.length).toBeGreaterThan(0);
  });
});
