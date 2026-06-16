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

function findObserve(calls: PostCall[], hookType: string): PostCall | undefined {
  return calls.find((c) => c.url.endsWith("/agentmemory/observe") && c.body?.hookType === hookType);
}

function findPost(calls: PostCall[], path: string): PostCall | undefined {
  return calls.find((c) => c.url.endsWith(`/agentmemory${path}`));
}

function countObserve(calls: PostCall[], hookType: string, callId?: string): number {
  return calls.filter((c) =>
    c.url.endsWith("/agentmemory/observe") &&
    c.body?.hookType === hookType &&
    (callId === undefined || c.body?.data?.call_id === callId || c.body?.data?.subtask_id === callId),
  ).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle bus events
// ─────────────────────────────────────────────────────────────────────────────
describe("characterization: session lifecycle bus events", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("session.created posts /session/start with sessionId", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s_char_created", title: "T", parentID: null, version: "1" } } } as any,
    });
    const start = findPost(calls, "/session/start");
    expect(start).toBeDefined();
    expect(start!.body.sessionId).toBe("s_char_created");
    expect(start!.body.title).toBe("T");
  });

  it("session.status idle posts /session/checkpoint and observes session_status", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.status", properties: { sessionID: "s_char_idle", status: { type: "idle", attempt: 0, message: "done" } } } as any,
    });
    expect(findPost(calls, "/session/checkpoint")).toBeDefined();
    const obs = findObserve(calls, "session_status");
    expect(obs).toBeDefined();
    expect(obs!.body.data.status_type).toBe("idle");
  });

  it("session.status busy observes session_status WITHOUT checkpoint", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.status", properties: { sessionID: "s_char_busy", status: { type: "busy" } } } as any,
    });
    expect(findPost(calls, "/session/checkpoint")).toBeUndefined();
    const obs = findObserve(calls, "session_status");
    expect(obs).toBeDefined();
    expect(obs!.body.data.status_type).toBe("busy");
  });

  it("session.status retry observes session_status WITHOUT checkpoint", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.status", properties: { sessionID: "s_char_retry", status: { type: "retry", attempt: 2 } } } as any,
    });
    expect(findPost(calls, "/session/checkpoint")).toBeUndefined();
    const obs = findObserve(calls, "session_status");
    expect(obs).toBeDefined();
    expect(obs!.body.data.status_type).toBe("retry");
    expect(obs!.body.data.attempt).toBe(2);
  });

  it("session.compacted posts /session/checkpoint and observes session_compacted", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.compacted", properties: { sessionID: "s_char_compacted" } } as any,
    });
    expect(findPost(calls, "/session/checkpoint")).toBeDefined();
    expect(findObserve(calls, "session_compacted")).toBeDefined();
  });

  it("session.updated after session.created (fresh sid) observes session_updated with NO resumed start", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s_char_fresh" } } } as any,
    });
    calls.length = 0;
    await plugin.event!({
      event: { type: "session.updated", properties: { info: { id: "s_char_fresh", title: "Updated", summary: { additions: 3, deletions: 1, files: ["a.ts"] } } } } as any,
    });
    const resumeStart = calls.find((c) => c.url.endsWith("/agentmemory/session/start") && c.body?.resumed === true);
    expect(resumeStart).toBeUndefined();
    const obs = findObserve(calls, "session_updated");
    expect(obs).toBeDefined();
    expect(obs!.body.data.title).toBe("Updated");
    expect(obs!.body.data.additions).toBe(3);
  });

  it("session.updated for unseen sid posts /session/start resumed:true and observes session_updated", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.updated", properties: { info: { id: "s_char_resumed", title: "Old" } } } as any,
    });
    const resumeStart = calls.find((c) => c.url.endsWith("/agentmemory/session/start") && c.body?.resumed === true);
    expect(resumeStart).toBeDefined();
    expect(resumeStart!.body.sessionId).toBe("s_char_resumed");
    expect(findObserve(calls, "session_updated")).toBeDefined();
  });

  it("session.diff observes session_diff with files array and summed additions/deletions", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "session.diff",
        properties: {
          sessionID: "s_char_diff",
          diff: [
            { file: "a.ts", additions: 3, deletions: 1 },
            { file: "b.ts", additions: 2, deletions: 0 },
          ],
        },
      } as any,
    });
    const obs = findObserve(calls, "session_diff");
    expect(obs).toBeDefined();
    expect(obs!.body.data.files).toEqual(["a.ts", "b.ts"]);
    expect(obs!.body.data.additions).toBe(5);
    expect(obs!.body.data.deletions).toBe(1);
  });

  it("session.deleted posts /session/end + /crystals/auto + /consolidate-pipeline", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.deleted", properties: { sessionID: "s_char_deleted" } } as any,
    });
    const end = findPost(calls, "/session/end");
    expect(end).toBeDefined();
    expect(end!.body.sessionId).toBe("s_char_deleted");
    expect(findPost(calls, "/crystals/auto")).toBeDefined();
    expect(findPost(calls, "/consolidate-pipeline")).toBeDefined();
  });

  it("session.error observes post_tool_failure with tool_name=session.error", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.error", properties: { sessionID: "s_char_error", error: "boom went the dynamite" } } as any,
    });
    const obs = findObserve(calls, "post_tool_failure");
    expect(obs).toBeDefined();
    expect(obs!.body.data.tool_name).toBe("session.error");
    expect(obs!.body.data.tool_output).toContain("boom went the dynamite");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────
describe("characterization: message bus events", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("message.updated assistant observes assistant_message with modelID/providerID/tokens shape", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s_char_assistant",
          info: {
            role: "assistant",
            id: "msg_a",
            parentID: "msg_p",
            modelID: "claude-x",
            providerID: "anthropic",
            mode: "build",
            cost: 0.02,
            tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } },
            finish: "stop",
            time: { created: 100, completed: 500 },
          },
        },
      } as any,
    });
    const obs = findObserve(calls, "assistant_message");
    expect(obs).toBeDefined();
    expect(obs!.body.data.modelID).toBe("claude-x");
    expect(obs!.body.data.providerID).toBe("anthropic");
    expect(obs!.body.data.tokens.input).toBe(100);
    expect(obs!.body.data.tokens.output).toBe(50);
    expect(obs!.body.data.tokens.cache_read).toBe(5);
    expect(obs!.body.data.duration_ms).toBe(400);
  });

  it("message.updated user observes user_message", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s_char_user",
          info: { role: "user", id: "msg_u", parentID: null, mode: "build", time: { created: 123 } },
        },
      } as any,
    });
    const obs = findObserve(calls, "user_message");
    expect(obs).toBeDefined();
    expect(obs!.body.data.messageID).toBe("msg_u");
    expect(obs!.body.data.time_created).toBe(123);
  });

  it("message.removed observes message_removed with messageID", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "message.removed", properties: { sessionID: "s_char_msgrm", messageID: "msg_x" } } as any,
    });
    const obs = findObserve(calls, "message_removed");
    expect(obs).toBeDefined();
    expect(obs!.body.data.messageID).toBe("msg_x");
  });

  it("message.part.removed observes message_part_removed with messageID/partID", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "message.part.removed", properties: { sessionID: "s_char_partrm", messageID: "msg_y", partID: "part_z" } } as any,
    });
    const obs = findObserve(calls, "message_part_removed");
    expect(obs).toBeDefined();
    expect(obs!.body.data.messageID).toBe("msg_y");
    expect(obs!.body.data.partID).toBe("part_z");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// message.part.updated subtypes
// ─────────────────────────────────────────────────────────────────────────────
describe("characterization: message.part.updated subtypes", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("subtask observes subagent_start and dedupes on second fire", async () => {
    const { plugin, calls } = await loadPlugin();
    const evt = {
      event: {
        type: "message.part.updated",
        properties: {
          part: { type: "subtask", sessionID: "s_char_subtask", id: "sub_1", agent: "explore", prompt: "go", description: "desc" },
        },
      } as any,
    };
    await plugin.event!(evt);
    await plugin.event!(evt);
    const obs = findObserve(calls, "subagent_start");
    expect(obs).toBeDefined();
    expect(obs!.body.data.subtask_id).toBe("sub_1");
    expect(obs!.body.data.agent).toBe("explore");
    expect(countObserve(calls, "subagent_start", "sub_1")).toBe(1);
  });

  it("tool completed observes post_tool_use and dedupes on second fire", async () => {
    const { plugin, calls } = await loadPlugin();
    const evt = {
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "s_char_toolok",
            callID: "call_ok",
            tool: "Bash",
            state: { status: "completed", input: "ls", output: "file.txt", title: "Bash", metadata: {}, time: { start: 100, end: 250 } },
          },
        },
      } as any,
    };
    await plugin.event!(evt);
    await plugin.event!(evt);
    const obs = findObserve(calls, "post_tool_use");
    expect(obs).toBeDefined();
    expect(obs!.body.data.tool_name).toBe("Bash");
    expect(obs!.body.data.call_id).toBe("call_ok");
    expect(obs!.body.data.duration_ms).toBe(150);
    expect(countObserve(calls, "post_tool_use", "call_ok")).toBe(1);
  });

  it("tool error observes post_tool_failure", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "s_char_toolerr",
            callID: "call_err",
            tool: "Bash",
            state: { status: "error", input: "rm -rf", error: "permission denied", time: {} },
          },
        },
      } as any,
    });
    const obs = findObserve(calls, "post_tool_failure");
    expect(obs).toBeDefined();
    expect(obs!.body.data.tool_name).toBe("Bash");
    expect(obs!.body.data.call_id).toBe("call_err");
    expect(obs!.body.data.tool_output).toContain("permission denied");
  });

  it("step-finish observes step_finish with input/output tokens", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: { type: "step-finish", sessionID: "s_char_step", messageID: "m1", reason: "stop", cost: 0.01, tokens: { input: 10, output: 20, reasoning: 5 } },
        },
      } as any,
    });
    const obs = findObserve(calls, "step_finish");
    expect(obs).toBeDefined();
    expect(obs!.body.data.input_tokens).toBe(10);
    expect(obs!.body.data.output_tokens).toBe(20);
    expect(obs!.body.data.reasoning_tokens).toBe(5);
  });

  it("reasoning observes reasoning with sliced text", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "reasoning", sessionID: "s_char_reason", messageID: "m1", text: "thinking hard about it" } },
      } as any,
    });
    const obs = findObserve(calls, "reasoning");
    expect(obs).toBeDefined();
    expect(obs!.body.data.text).toBe("thinking hard about it");
  });

  it("patch observes patch_applied with hash and files", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "patch", sessionID: "s_char_patch", messageID: "m1", hash: "abc123", files: ["x.ts", "y.ts"] } },
      } as any,
    });
    const obs = findObserve(calls, "patch_applied");
    expect(obs).toBeDefined();
    expect(obs!.body.data.hash).toBe("abc123");
    expect(obs!.body.data.files).toEqual(["x.ts", "y.ts"]);
  });

  it("compaction observes compaction_event", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "compaction", sessionID: "s_char_comppart", messageID: "m1", auto: true } },
      } as any,
    });
    const obs = findObserve(calls, "compaction_event");
    expect(obs).toBeDefined();
    expect(obs!.body.data.auto).toBe(true);
  });

  it("agent observes agent_selected with name", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "agent", sessionID: "s_char_agent", messageID: "m1", name: "build" } },
      } as any,
    });
    const obs = findObserve(calls, "agent_selected");
    expect(obs).toBeDefined();
    expect(obs!.body.data.name).toBe("build");
  });

  it("retry observes retry_attempt", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "retry", sessionID: "s_char_retrypart", messageID: "m1", attempt: 3, error: "rate limit" } },
      } as any,
    });
    const obs = findObserve(calls, "retry_attempt");
    expect(obs).toBeDefined();
    expect(obs!.body.data.attempt).toBe(3);
    expect(obs!.body.data.error).toContain("rate limit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Permissions
// ─────────────────────────────────────────────────────────────────────────────
describe("characterization: permission bus events", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("permission.updated observes notification with notification_type=permission_prompt", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "permission.updated",
        properties: { sessionID: "s_char_permupd", type: "bash", pattern: ["npm *"], callID: "c1", title: "Run", metadata: {} },
      } as any,
    });
    const obs = findObserve(calls, "notification");
    expect(obs).toBeDefined();
    expect(obs!.body.data.notification_type).toBe("permission_prompt");
    expect(obs!.body.data.permission).toBe("bash");
  });

  it("permission.asked observes permission_asked", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "permission.asked",
        properties: {
          id: "perm_1",
          sessionID: "s_char_permask",
          permission: "Bash",
          patterns: ["npm *"],
          always: ["pnpm *"],
          tool: { messageID: "msg_1", callID: "call_1" },
          metadata: {},
        },
      } as any,
    });
    const obs = findObserve(calls, "permission_asked");
    expect(obs).toBeDefined();
    expect(obs!.body.data.permission_id).toBe("perm_1");
    expect(obs!.body.data.permission).toBe("Bash");
    expect(obs!.body.data.patterns).toEqual(["npm *"]);
    expect(obs!.body.data.tool_call_id).toBe("call_1");
  });

  it("permission.replied observes permission_replied", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "permission.replied",
        properties: { sessionID: "s_char_permrep", permissionID: "perm_2", response: "allow" },
      } as any,
    });
    const obs = findObserve(calls, "permission_replied");
    expect(obs).toBeDefined();
    expect(obs!.body.data.permission_id).toBe("perm_2");
    expect(obs!.body.data.response).toBe("allow");
  });

  it("permission.v2.asked observes permission_v2_asked", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "permission.v2.asked",
        properties: { id: "v2_1", sessionID: "s_char_permv2ask", action: "read", resources: ["/secret"], save: ["always"], metadata: {} },
      } as any,
    });
    const obs = findObserve(calls, "permission_v2_asked");
    expect(obs).toBeDefined();
    expect(obs!.body.data.action).toBe("read");
    expect(obs!.body.data.resources).toEqual(["/secret"]);
  });

  it("permission.v2.replied observes permission_v2_replied", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "permission.v2.replied",
        properties: { sessionID: "s_char_permv2rep", requestID: "req_1", reply: "allow" },
      } as any,
    });
    const obs = findObserve(calls, "permission_v2_replied");
    expect(obs).toBeDefined();
    expect(obs!.body.data.request_id).toBe("req_1");
    expect(obs!.body.data.reply).toBe("allow");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tasks, commands, and active-session-only events
// ─────────────────────────────────────────────────────────────────────────────
describe("characterization: tasks, commands, watcher, vcs", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("todo.updated observes task_completed with completed + in_progress arrays", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: {
        type: "todo.updated",
        properties: {
          sessionID: "s_char_todo",
          todos: [
            { content: "done thing", status: "completed", priority: "high" },
            { content: "active thing", status: "in_progress", priority: "medium" },
          ],
        },
      } as any,
    });
    const obs = findObserve(calls, "task_completed");
    expect(obs).toBeDefined();
    expect(obs!.body.data.completed).toEqual([{ content: "done thing", priority: "high" }]);
    expect(obs!.body.data.in_progress).toEqual([{ content: "active thing", priority: "medium" }]);
    expect(obs!.body.data.total).toBe(2);
  });

  it("command.executed observes command_executed with name + arguments", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "command.executed", properties: { sessionID: "s_char_cmdexec", name: "deploy", arguments: "--env=prod" } } as any,
    });
    const obs = findObserve(calls, "command_executed");
    expect(obs).toBeDefined();
    expect(obs!.body.data.name).toBe("deploy");
    expect(obs!.body.data.arguments).toBe("--env=prod");
  });

  it("file.watcher.updated observes file_watcher when an active session exists", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s_char_watcher" } } } as any,
    });
    calls.length = 0;
    await plugin.event!({
      event: { type: "file.watcher.updated", properties: { file: "/tmp/changed.ts", event: "change" } } as any,
    });
    const obs = findObserve(calls, "file_watcher");
    expect(obs).toBeDefined();
    expect(obs!.body.data.file).toBe("/tmp/changed.ts");
    expect(obs!.body.data.event).toBe("change");
  });

  it("vcs.branch.updated observes vcs_branch_updated when an active session exists", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s_char_vcs" } } } as any,
    });
    calls.length = 0;
    await plugin.event!({
      event: { type: "vcs.branch.updated", properties: { branch: "feature/oauth" } } as any,
    });
    const obs = findObserve(calls, "vcs_branch_updated");
    expect(obs).toBeDefined();
    expect(obs!.body.data.branch).toBe("feature/oauth");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Typed hooks
// ─────────────────────────────────────────────────────────────────────────────
describe("characterization: typed hooks", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("chat.message observes prompt_submit with agent/model/files/prompt", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin["chat.message"]!(
      { sessionID: "s_char_chatmsg", agent: "build", model: "anthropic/claude-x", variant: null } as any,
      { parts: [{ type: "text", text: "hello world" }, { type: "file", filename: "/tmp/a.ts" }] } as any,
    );
    const obs = findObserve(calls, "prompt_submit");
    expect(obs).toBeDefined();
    expect(obs!.body.data.agent).toBe("build");
    expect(obs!.body.data.model).toBe("anthropic/claude-x");
    expect(obs!.body.data.prompt).toContain("hello world");
    expect(obs!.body.data.files).toContain("/tmp/a.ts");
  });

  it("chat.params observes llm_params with model id + provider url + temperature", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin["chat.params"]!(
      {
        sessionID: "s_char_chatparams",
        agent: "build",
        model: {
          providerID: "anthropic",
          id: "claude-x",
          api: { url: "https://api.anthropic.com" },
          limit: { output: 4096, context: 200000 },
          cost: { input: 3, output: 15 },
        },
      } as any,
      { temperature: 0.7, topP: 0.9 } as any,
    );
    const obs = findObserve(calls, "llm_params");
    expect(obs).toBeDefined();
    expect(obs!.body.data.model).toBe("anthropic/claude-x");
    expect(obs!.body.data.provider_url).toBe("https://api.anthropic.com");
    expect(obs!.body.data.temperature).toBe(0.7);
  });

  it("tool.execute.after observes post_tool_use", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin["tool.execute.after"]!(
      { tool: "Read", sessionID: "s_char_toolafter", callID: "call_after", args: { filePath: "/tmp/x.txt" } } as any,
      { output: "file contents", title: "Read /tmp/x.txt", metadata: { size: 42 } } as any,
    );
    const obs = findObserve(calls, "post_tool_use");
    expect(obs).toBeDefined();
    expect(obs!.body.data.tool_name).toBe("Read");
    expect(obs!.body.data.call_id).toBe("call_after");
    expect(obs!.body.data.tool_output).toContain("file contents");
  });

  it("experimental.chat.system.transform first call posts /context and pushes instructions", async () => {
    const { plugin, calls } = await loadPlugin();
    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]!(
      { sessionID: "s_char_systransform" } as any,
      output as any,
    );
    expect(findPost(calls, "/context")).toBeDefined();
    expect(output.system.some((s) => /agentmemory-instructions/.test(s))).toBe(true);
    expect(output.system).toContain("<test-context>");
  });

  it("experimental.chat.system.transform posts /enrich with stashed files and clears the stash", async () => {
    const { plugin, calls } = await loadPlugin();
    const sid = "s_char_enrich";
    await plugin["tool.execute.before"]!(
      { tool: "Read", sessionID: sid } as any,
      { args: { filePath: "/tmp/enrich-me.ts" } } as any,
    );
    await plugin["experimental.chat.system.transform"]!(
      { sessionID: sid } as any,
      { system: [] as string[] } as any,
    );
    const enrich = findPost(calls, "/enrich");
    expect(enrich).toBeDefined();
    expect(enrich!.body.files).toContain("/tmp/enrich-me.ts");
    expect(enrich!.body.toolName).toBe("enrich_inject");

    const enrichCountBefore = calls.filter((c) => c.url.endsWith("/agentmemory/enrich")).length;
    await plugin["experimental.chat.system.transform"]!(
      { sessionID: sid } as any,
      { system: [] as string[] } as any,
    );
    const enrichCountAfter = calls.filter((c) => c.url.endsWith("/agentmemory/enrich")).length;
    expect(enrichCountAfter).toBe(enrichCountBefore);
  });

  it("experimental.chat.messages.transform observes messages_transform with message_count", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s_char_msgtransform" } } } as any,
    });
    calls.length = 0;
    await plugin["experimental.chat.messages.transform"]!(
      {} as any,
      { messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }] } as any,
    );
    const obs = findObserve(calls, "messages_transform");
    expect(obs).toBeDefined();
    expect(obs!.body.data.message_count).toBe(3);
  });

  it("experimental.session.compacting posts /context and pushes into output.context", async () => {
    const { plugin, calls } = await loadPlugin();
    const output = { context: [] as string[] };
    await plugin["experimental.session.compacting"]!(
      { sessionID: "s_char_compacting" } as any,
      output as any,
    );
    expect(findPost(calls, "/context")).toBeDefined();
    expect(output.context).toContain("<test-context>");
  });

  it("command.execute.before observes command_before", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin["command.execute.before"]!(
      { command: "deploy", sessionID: "s_char_cmdbefore", arguments: "--env=prod --force" } as any,
      { parts: [] } as any,
    );
    const obs = findObserve(calls, "command_before");
    expect(obs).toBeDefined();
    expect(obs!.body.data.command).toBe("deploy");
    expect(obs!.body.data.arguments).toBe("--env=prod --force");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// config + dispose lifecycle
// ─────────────────────────────────────────────────────────────────────────────
describe("characterization: config and dispose", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => { await teardownPlugin(); });

  it("config with no active session stashes pendingConfig (no /observe) then fires config_loaded on session.created", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.config!({
      theme: "dark",
      model: "anthropic/claude-x",
      agent: { build: {}, plan: {} },
      mcp: { agentmemory: {} },
      provider: { anthropic: {} },
      permission: {},
    } as any);
    expect(findObserve(calls, "config_loaded")).toBeUndefined();

    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s_char_config_pending" } } } as any,
    });
    const obs = findObserve(calls, "config_loaded");
    expect(obs).toBeDefined();
    expect(obs!.body.data.theme).toBe("dark");
  });

  it("config with active session observes config_loaded with theme/model/agents/mcp_servers/providers", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s_char_config_active" } } } as any,
    });
    calls.length = 0;
    await plugin.config!({
      theme: "light",
      model: "anthropic/claude-y",
      agent: { build: {}, plan: {} },
      mcp: { agentmemory: {} },
      provider: { anthropic: {}, openai: {} },
      permission: {},
    } as any);
    const obs = findObserve(calls, "config_loaded");
    expect(obs).toBeDefined();
    expect(obs!.body.data.theme).toBe("light");
    expect(obs!.body.data.model).toBe("anthropic/claude-y");
    expect(obs!.body.data.agents).toEqual(["build", "plan"]);
    expect(obs!.body.data.mcp_servers).toEqual(["agentmemory"]);
    expect(obs!.body.data.providers).toEqual(["anthropic", "openai"]);
  });

  it("dispose fires /session/checkpoint for the active session and does NOT post /session/end", async () => {
    const { plugin, calls } = await loadPlugin();
    await plugin.event!({
      event: { type: "session.created", properties: { info: { id: "s_char_dispose" } } } as any,
    });
    calls.length = 0;
    await plugin.dispose!();
    expect(findPost(calls, "/session/checkpoint")).toBeDefined();
    expect(findPost(calls, "/session/end")).toBeUndefined();
  });
});
