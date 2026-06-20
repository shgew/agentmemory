import type { Plugin } from "@opencode-ai/plugin";

const API = process.env.AGENTMEMORY_URL || "http://localhost:3111";
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);
const FILE_KEYS = ["filePath", "file_path", "path", "file", "pattern"];
const MAX_STASHED_FILES = 20;

const DEBUG = process.env.OPENCODE_AGENTMEMORY_DEBUG === "1";
const SECRET = process.env.AGENTMEMORY_SECRET || "";

type Summary = { additions?: number; deletions?: number; files?: number };
type TokenCache = { read?: number; write?: number };
type AssistantTime = { created?: number; completed?: number };
type ToolTime = { start?: number; end?: number };
type StepFinishExtras = {
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number };
};
type ReasoningExtras = { text?: string };
type FilePartExtras = { filename?: string; url?: string };
type PatchExtras = { hash?: string; files?: string[] };
type CompactionExtras = { auto?: boolean };
type AgentExtras = { name?: string };
type ContextResponse = { context?: string };
type TodoItem = { content?: string; priority?: string; status?: string };
type MessagePartLite = {
  type?: string;
  filename?: string;
  url?: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
};
type AttachmentLite = { filename?: string; url?: string };

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) headers["Authorization"] = `Bearer ${SECRET}`;
  return headers;
}

async function post(path: string, body: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
  try {
    await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (e as Error).message);
  }
}

async function postJson<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  try {
    const res = await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch (e) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (e as Error).message);
    return null;
  }
}

async function observe(
  sessionId: string,
  hookType: string,
  data: Record<string, unknown>,
): Promise<void> {
  await post("/observe", {
    hookType,
    sessionId,
    project: projectPath,
    cwd: projectPath,
    timestamp: new Date().toISOString(),
    data,
  });
}

let activeSessionId: string | null = null;
let pendingConfig: Record<string, unknown> | null = null;
let projectPath: string | null = null;
const stashedFiles = new Map<string, Set<string>>();
const seenSubtaskIds = new Map<string, Set<string>>();
const seenToolCallIds = new Map<string, Set<string>>();
const contextInjectedSessions = new Set<string>();
// cache the context returned by POST /session/start so the chat
// system-transform hook can inject it without a second /context fetch.
// Auto-injection now happens at session.created (immediately) AND at
// the first prompt_submit (fallback for older OpenCode builds that
// don't implement experimental.chat.system.transform).
const startContextCache = new Map<string, string>();

function stashFor(sid: string): Set<string> {
  let s = stashedFiles.get(sid);
  if (!s) { s = new Set<string>(); stashedFiles.set(sid, s); }
  return s;
}

function subtaskSetFor(sid: string): Set<string> {
  let s = seenSubtaskIds.get(sid);
  if (!s) { s = new Set<string>(); seenSubtaskIds.set(sid, s); }
  return s;
}

function toolCallSetFor(sid: string): Set<string> {
  let s = seenToolCallIds.get(sid);
  if (!s) { s = new Set<string>(); seenToolCallIds.set(sid, s); }
  return s;
}

function safeSlice(v: unknown, max: number): string {
  if (typeof v === "string") return v.slice(0, max);
  if (v == null) return "";
  try { return JSON.stringify(v).slice(0, max); } catch { return ""; }
}

const AGENTMEMORY_INSTRUCTIONS = `<agentmemory-instructions>
You have access to agentmemory for persistent cross-session memory. Use these tools proactively.

CORE TOOLS:

memory_save — Save an insight, decision, or fact to long-term memory.
  Required: content (text), concepts (2-5 comma-separated keywords), type (pattern/preference/architecture/bug/workflow/fact)
  Optional: files (comma-separated paths)
  Use when: user says "remember this", after discovering a bug, after making an architectural decision, after learning a project convention.

memory_recall — Search past observations by keywords.
  Use when: user says "recall", "what did we do", "do you remember", or needs context from past sessions.

memory_smart_search — Hybrid semantic+keyword search with progressive disclosure.
  Use when: you need the most relevant past context, fuzzy/conceptual searches, or recall doesn't find what you need.

memory_sessions — List recent sessions with status and observation counts.
  Use when: user asks about session/past history, "what did we work on".

memory_file_history — Get past observations about specific files (across all sessions).
  Use when: you're about to edit a file and want to know its history, common pitfalls, or past edits.

memory_lesson_save — Save a lesson learned (what worked, what to avoid).
  Use when: you discover a pattern that could help future sessions avoid mistakes.

memory_lesson_recall — Search lessons by query. Returns lessons sorted by confidence.
  Use when: before making a decision, check if past lessons apply.

memory_governance_delete — Delete specific memories. Requires explicit user confirmation.
  Use when: user says "forget this", "delete that memory".

memory_patterns — Detect recurring patterns across sessions.
  Use when: you want to understand project-level trends over time.

memory_consolidate — Run the 4-tier memory consolidation pipeline.
  Use when: you want to compress and organize accumulated session observations.

All memory tools start with \`agentmemory_memory_\`. Use the exact names as they appear in your tool list. Tool results are JSON. Always check what was returned before presenting to the user.
</agentmemory-instructions>`;

function extractFilePaths(args: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const key of FILE_KEYS) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      files.push(val);
    }
  }
  return files;
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (e.data && typeof e.data === "object") {
      const d = e.data as Record<string, unknown>;
      if (typeof d.message === "string") return d.message;
    }
    if (typeof e.name === "string") return e.name;
    try { return JSON.stringify(err); } catch { return ""; }
  }
  return String(err ?? "");
}

export const AgentmemoryCapturePlugin: Plugin = async (ctx) => {
  projectPath = ctx.worktree || ctx.project?.id || process.cwd();

  return {
    event: async ({ event }) => {
      // ── session.created ──
      if (event.type === "session.created") {
        const info = event.properties.info;
        activeSessionId = info?.id ?? null;
        if (!activeSessionId) return;
        stashedFiles.set(activeSessionId, new Set());
        seenSubtaskIds.delete(activeSessionId);
        seenToolCallIds.delete(activeSessionId);
        contextInjectedSessions.delete(activeSessionId);
        // Snapshot the session id locally — `activeSessionId` is mutable
        // and another `session.created` event during the await could
        // rebind it, causing context to be cached against the wrong key.
        const sessionId = activeSessionId;
        const startResult = await postJson<ContextResponse>("/session/start", {
          sessionId,
          title: info?.title ?? null,
          parentID: info?.parentID ?? null,
          version: info?.version ?? null,
          project: projectPath,
          cwd: projectPath,
        });
        // cache the context returned at session/start so the
        // chat.system.transform hook injects it without a second fetch.
        const startCtx = startResult?.context;
        if (typeof startCtx === "string" && startCtx.length > 0) {
          startContextCache.set(sessionId, startCtx);
        }
        if (pendingConfig) {
          await observe(sessionId, "config_loaded", pendingConfig);
          pendingConfig = null;
        }
      }

      // ── session.idle ── (summarize handled in session.status idle branch)

      // ── session.status ──
      if (event.type === "session.status") {
        const status = event.properties.status;
        const sid = activeSessionId;
        if (!sid || !status) return;
        if (status.type === "idle") {
          await post("/summarize", { sessionId: sid });
        }
        await observe(sid, "session_status", {
          status_type: status.type,
          attempt: (status as { attempt?: number }).attempt ?? null,
          message: safeSlice((status as { message?: unknown }).message, 2000),
        });
      }

      // ── session.compacted ──
      if (event.type === "session.compacted") {
        const sid = activeSessionId;
        if (sid) {
          await post("/summarize", { sessionId: sid });
          await observe(sid, "session_compacted", {});
        }
      }

      // ── session.updated ──
      if (event.type === "session.updated") {
        const info = event.properties.info;
        const sid = info?.id ?? activeSessionId;
        if (!sid) return;
        const summary = info?.summary as Summary | undefined;
        await observe(sid, "session_updated", {
          title: info?.title ?? null,
          parentID: info?.parentID ?? null,
          additions: summary?.additions ?? null,
          deletions: summary?.deletions ?? null,
          files: summary?.files ?? null,
        });
      }

      // ── session.diff ──
      if (event.type === "session.diff") {
        const sid = activeSessionId;
        const diffsRaw = (event.properties as { diff?: unknown }).diff;
        if (!sid || !Array.isArray(diffsRaw)) return;
        const diffs = diffsRaw as Array<Record<string, unknown>>;
        await observe(sid, "session_diff", {
          files: diffs.map(d => d.file),
          additions: diffs.reduce((s, d) => s + ((d.additions as number) || 0), 0),
          deletions: diffs.reduce((s, d) => s + ((d.deletions as number) || 0), 0),
          diffs: diffs.slice(0, 50),
        });
      }

      // ── session.deleted ──
      if (event.type === "session.deleted") {
        const info = event.properties.info;
        const sid = info?.id ?? activeSessionId;
        if (!sid) {
          if (DEBUG) console.error("[agentmemory] session.deleted with no session ID");
          return;
        }
        await post("/session/end", { sessionId: sid });
        post("/crystals/auto", { olderThanDays: 7 }, 30000);
        post("/consolidate-pipeline", { tier: "all", force: true }, 30000);
        if (sid === activeSessionId) activeSessionId = null;
        stashedFiles.delete(sid);
        startContextCache.delete(sid);
        seenSubtaskIds.delete(sid);
        seenToolCallIds.delete(sid);
        contextInjectedSessions.delete(sid);
      }

      // ── session.error ──
      if (event.type === "session.error") {
        const sid = activeSessionId;
        if (sid) {
          const err = (event.properties as { error?: unknown }).error;
          await observe(sid, "post_tool_failure", {
            tool_name: "session.error",
            tool_input: "",
            tool_output: safeSlice(err, 8000),
          });
        }
      }

      // ── message.updated ──
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (!info) return;

        if (info.role === "assistant") {
          const sid = info.sessionID ?? activeSessionId;
          if (!sid) return;
          const tokens = info.tokens as
            | { input?: number; output?: number; reasoning?: number; cache?: TokenCache }
            | undefined;
          const error = info.error ? extractErrorMessage(info.error) : null;
          const time = info.time as AssistantTime | undefined;
          const completed = typeof time?.completed === "number" ? time.completed : null;
          const created = typeof time?.created === "number" ? time.created : 0;
          await observe(sid, "assistant_message", {
            messageID: info.id,
            parentID: info.parentID,
            modelID: info.modelID,
            providerID: info.providerID,
            mode: info.mode,
            cost: info.cost ?? 0,
            tokens: {
              input: tokens?.input ?? 0,
              output: tokens?.output ?? 0,
              reasoning: tokens?.reasoning ?? 0,
              cache_read: tokens?.cache?.read ?? 0,
              cache_write: tokens?.cache?.write ?? 0,
            },
            finish: info.finish ?? null,
            error,
            duration_ms: completed != null ? completed - created : null,
          });
        }
      }

      // ── message.removed ──
      if (event.type === "message.removed") {
        const sid = activeSessionId;
        if (sid) {
          await observe(sid, "message_removed", {
            messageID: (event.properties as { messageID?: string }).messageID,
          });
        }
      }

      // ── message.part.updated ──
      if (event.type === "message.part.updated") {
        const part = event.properties.part;
        if (!part) return;
        const sid = part.sessionID ?? activeSessionId;
        if (!sid) return;

        if (part.type === "subtask") {
          const subtaskId = part.id;
          if (!subtaskId) return;
          const subtaskSet = subtaskSetFor(sid);
          if (subtaskSet.has(subtaskId)) return;
          subtaskSet.add(subtaskId);
          await observe(sid, "subagent_start", {
            subtask_id: part.id,
            agent: (part as { agent?: string }).agent,
            prompt: safeSlice((part as { prompt?: unknown }).prompt, 4000),
            description: safeSlice((part as { description?: unknown }).description, 2000),
          });
          return;
        }

        if (part.type === "tool") {
          const state = (part as { state?: Record<string, unknown> }).state;
          if (!state) return;
          const callId = (part as { callID?: string }).callID;
          if (!callId) return;
          const toolName = (part as { tool?: string }).tool;

          if (state.status === "completed") {
            const callSet = toolCallSetFor(sid);
            if (callSet.has(callId)) return;
            callSet.add(callId);
            const rawTime = (state.time as ToolTime | undefined) ?? {};
            const startTime = typeof rawTime.start === "number" ? rawTime.start : null;
            const endTime = typeof rawTime.end === "number" ? rawTime.end : null;
            const attachmentsRaw = state.attachments;
            await observe(sid, "post_tool_use", {
              tool_name: toolName,
              call_id: callId,
              tool_input: safeSlice(state.input, 4000),
              tool_output: safeSlice(state.output, 8000),
              title: state.title ?? null,
              metadata: state.metadata || {},
              duration_ms: (startTime != null && endTime != null) ? endTime - startTime : null,
              attachments: Array.isArray(attachmentsRaw)
                ? (attachmentsRaw as AttachmentLite[]).map(a => a.filename || a.url)
                : [],
            });
          } else if (state.status === "error") {
            const callSet = toolCallSetFor(sid);
            if (callSet.has(callId)) return;
            callSet.add(callId);
            const rawTime = (state.time as ToolTime | undefined) ?? {};
            const startTime = typeof rawTime.start === "number" ? rawTime.start : null;
            const endTime = typeof rawTime.end === "number" ? rawTime.end : null;
            await observe(sid, "post_tool_failure", {
              tool_name: toolName,
              call_id: callId,
              tool_input: safeSlice(state.input, 4000),
              tool_output: safeSlice(state.error, 8000),
              duration_ms: (startTime != null && endTime != null) ? endTime - startTime : null,
            });
          }
          return;
        }

        if (part.type === "step-finish") {
          const extras = part as StepFinishExtras;
          await observe(sid, "step_finish", {
            messageID: (part as { messageID?: string }).messageID,
            reason: (part as { reason?: string }).reason ?? null,
            cost: extras.cost ?? 0,
            input_tokens: extras.tokens?.input ?? 0,
            output_tokens: extras.tokens?.output ?? 0,
            reasoning_tokens: extras.tokens?.reasoning ?? 0,
          });
          return;
        }

        if (part.type === "reasoning") {
          await observe(sid, "reasoning", {
            messageID: (part as { messageID?: string }).messageID,
            text: safeSlice((part as ReasoningExtras).text, 4000),
          });
          return;
        }

        if (part.type === "file") {
          const fp = part as FilePartExtras;
          const filename = fp.filename || fp.url || null;
          if (filename) stashFor(sid).add(filename);
          return;
        }

        if (part.type === "patch") {
          const extras = part as PatchExtras;
          await observe(sid, "patch_applied", {
            messageID: (part as { messageID?: string }).messageID,
            hash: extras.hash,
            files: extras.files || [],
          });
          return;
        }

        if (part.type === "compaction") {
          await observe(sid, "compaction_event", {
            messageID: (part as { messageID?: string }).messageID,
            auto: (part as CompactionExtras).auto ?? false,
          });
          return;
        }

        if (part.type === "agent") {
          await observe(sid, "agent_selected", {
            messageID: (part as { messageID?: string }).messageID,
            name: (part as AgentExtras).name,
          });
          return;
        }

        if (part.type === "retry") {
          await observe(sid, "retry_attempt", {
            messageID: (part as { messageID?: string }).messageID,
            attempt: (part as { attempt?: number }).attempt,
            error: safeSlice((part as { error?: unknown }).error, 2000),
          });
          return;
        }
      }

      // ── file.edited ──
      if (event.type === "file.edited") {
        const sid = activeSessionId;
        const file = (event.properties as { file?: string }).file;
        if (sid && typeof file === "string" && file.length > 0) {
          const stash = stashFor(sid);
          stash.add(file);
          if (stash.size > MAX_STASHED_FILES) {
            const keep = [...stash].slice(-MAX_STASHED_FILES);
            stash.clear();
            for (const f of keep) stash.add(f);
          }
        }
      }

      // ── permission.updated ──
      if (event.type === "permission.updated") {
        const sid = activeSessionId;
        if (!sid) return;
        const p = event.properties as {
          type?: string;
          pattern?: string | string[];
          callID?: string;
          title?: string;
          metadata?: Record<string, unknown>;
        };
        await observe(sid, "notification", {
          notification_type: "permission_prompt",
          permission: p.type || "unknown",
          pattern: Array.isArray(p.pattern)
            ? p.pattern.join(", ")
            : (p.pattern || ""),
          tool_call_id: p.callID || null,
          title: p.title || p.type || "",
          metadata: p.metadata || {},
        });
      }

      // ── permission.replied ──
      if (event.type === "permission.replied") {
        const sid = activeSessionId;
        if (!sid) return;
        const p = event.properties as {
          permissionID?: string;
          requestID?: string;
          response?: string;
          reply?: string;
        };
        await observe(sid, "permission_replied", {
          permission_id: p.permissionID || p.requestID || "",
          response: p.response || p.reply || "",
        });
      }

      // ── todo.updated ──
      if (event.type === "todo.updated") {
        const sid = activeSessionId;
        const todosRaw = (event.properties as { todos?: unknown }).todos;
        const todos: TodoItem[] = Array.isArray(todosRaw) ? (todosRaw as TodoItem[]).slice(0, 100) : [];
        if (!sid || todos.length === 0) return;
        const completed = todos.filter(t => t.status === "completed");
        const active = todos.filter(t => t.status !== "completed");
        await observe(sid, "task_completed", {
          completed: completed.map(t => ({ content: t.content, priority: t.priority })),
          in_progress: active.map(t => ({ content: t.content, priority: t.priority })),
          total: todos.length,
        });
      }

      // ── command.executed ──
      if (event.type === "command.executed") {
        const sid = activeSessionId;
        if (sid) {
          const p = event.properties as { name?: string; arguments?: string };
          await observe(sid, "command_executed", {
            name: p.name,
            arguments: p.arguments || "",
          });
        }
      }
    },

    // ── chat.message ──
    "chat.message": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      const parts = (output.parts || []) as MessagePartLite[];
      const files = parts
        .filter(p => p.type === "file")
        .map(p => p.filename || p.url)
        .filter((f): f is string => Boolean(f));
      for (const f of files) {
        const stash = stashFor(sid);
        stash.add(f);
        if (stash.size > MAX_STASHED_FILES) {
          const keep = [...stash].slice(-MAX_STASHED_FILES);
          stash.clear();
          for (const k of keep) stash.add(k);
        }
      }

      const textParts = parts.filter(p => p.type === "text" && !p.synthetic && !p.ignored);
      const userText = textParts.map(p => p.text || "").join("\n");

      await observe(sid, "prompt_submit", {
        agent: input.agent ?? null,
        model: input.model ?? null,
        variant: input.variant ?? null,
        prompt: userText.slice(0, 8000),
        files: files.slice(0, 20),
        parts_summary: parts.map(p => p.type).filter((t): t is string => Boolean(t)),
      });
    },

    // ── chat.params ──
    "chat.params": async (input, output) => {
      if (!input.model || !output) return;
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      await observe(sid, "llm_params", {
        agent: input.agent,
        model: `${input.model.providerID}/${input.model.id}`,
        provider_url: input.model.api?.url ?? null,
        temperature: output.temperature,
        topP: output.topP,
        max_output_tokens: input.model.limit?.output ?? null,
        context_limit: input.model.limit?.context ?? null,
        cost_1k_input: input.model.cost?.input ?? 0,
        cost_1k_output: input.model.cost?.output ?? 0,
      });
    },

    // ── tool.execute.before ──
    "tool.execute.before": async (input, output) => {
      if (!FILE_TOOLS.has(input.tool)) return;
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      const args = output.args as Record<string, unknown> | undefined;
      if (!args) return;
      const stash = stashFor(sid);
      for (const fp of extractFilePaths(args)) {
        stash.add(fp);
      }
      if (stash.size > MAX_STASHED_FILES) {
        const keep = [...stash].slice(-MAX_STASHED_FILES);
        stash.clear();
        for (const f of keep) stash.add(f);
      }
    },

    // ── experimental.chat.system.transform ──
    "experimental.chat.system.transform": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;

      if (!contextInjectedSessions.has(sid)) {
        if (!Array.isArray(output.system)) return;
        output.system.push(AGENTMEMORY_INSTRUCTIONS);
        // prefer the context already fetched at session.created;
        // fall back to a fresh /context call if the cache missed (e.g.
        // session resumed across plugin reloads).
        let ctx = startContextCache.get(sid);
        if (typeof ctx !== "string" || ctx.length === 0) {
          const result = await postJson<ContextResponse>("/context", {
            sessionId: sid,
            project: projectPath,
          });
          ctx = result?.context;
        } else {
          startContextCache.delete(sid);
        }
        if (typeof ctx === "string" && ctx.length > 0) {
          output.system.push(ctx);
        }
        contextInjectedSessions.add(sid);
      }

      const stash = stashFor(sid);
      if (stash.size === 0) return;
      const files = [...stash].slice(0, 10);

      const enrichResult = await postJson<ContextResponse>("/enrich", {
        sessionId: sid,
        files,
        toolName: "enrich_inject",
      });

      const enrichCtx = enrichResult?.context;
      if (typeof enrichCtx === "string" && enrichCtx.length > 0) {
        if (Array.isArray(output.system)) {
          output.system.push(enrichCtx);
        }
        for (const f of files) stash.delete(f);
      }
    },

    // ── experimental.session.compacting (WIP) ──
    "experimental.session.compacting": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;

      const result = await postJson<ContextResponse>("/context", {
        sessionId: sid,
        project: projectPath,
      });
      const ctx = result?.context;
      if (typeof ctx === "string" && ctx.length > 0) {
        if (Array.isArray(output.context)) {
          output.context.push(ctx);
        }
      }
    },

    // ── config ──
    config: async (input) => {
      const payload: Record<string, unknown> = {
        theme: input.theme ?? null,
        model: input.model ?? null,
        autoupdate: input.autoupdate ?? null,
        agents: typeof input.agent === "object" && input.agent !== null && !Array.isArray(input.agent)
          ? Object.keys(input.agent as Record<string, unknown>)
          : Array.isArray(input.agent) ? input.agent : [],
        mcp_servers: typeof input.mcp === "object" && input.mcp !== null && !Array.isArray(input.mcp)
          ? Object.keys(input.mcp as Record<string, unknown>)
          : Array.isArray(input.mcp) ? input.mcp : [],
        providers: typeof input.provider === "object" && input.provider !== null && !Array.isArray(input.provider)
          ? Object.keys(input.provider as Record<string, unknown>)
          : Array.isArray(input.provider) ? input.provider : [],
        permission: input.permission ?? null,
      };
      if (activeSessionId) {
        await observe(activeSessionId, "config_loaded", payload);
      } else {
        pendingConfig = payload;
      }
    },
  };
};
