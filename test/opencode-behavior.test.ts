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

async function loadPlugin(): Promise<{ plugin: PluginInstance; calls: PostCall[] }> {
  const calls = installFetchMock();
  const plugin = await AgentmemoryCapturePlugin(FAKE_CTX);
  return { plugin, calls };
}

describe("OpenCode plugin behavior: command.execute.before payload", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

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
  afterEach(() => vi.unstubAllGlobals());

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

describe("OpenCode plugin behavior: permission.asked v2 payload", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

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
  afterEach(() => vi.unstubAllGlobals());

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
  afterEach(() => vi.unstubAllGlobals());

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
  afterEach(() => vi.unstubAllGlobals());

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

describe("OpenCode plugin behavior: session.idle separate from session.status", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("fires /summarize on bare session.idle event (also debounced)", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID: "s8" } } as any,
    });
    const summarize = calls.find((c) => c.url.endsWith("/agentmemory/summarize"));
    expect(summarize).toBeDefined();
  });

  it("second immediate session.idle is debounced", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: "s9" } } as any });
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: "s9" } } as any });
    const summarizes = calls.filter((c) => c.url.endsWith("/agentmemory/summarize"));
    expect(summarizes.length).toBe(1);
  });
});

describe("OpenCode plugin behavior: dispose does NOT end session", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

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
  afterEach(() => vi.unstubAllGlobals());

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
