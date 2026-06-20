/// <reference types="node" />
import { cwd, env } from "node:process";
import type { Plugin } from "@opencode-ai/plugin";
import type { Event as EventV1, Part } from "@opencode-ai/sdk";
import type { Event as EventV2 } from "@opencode-ai/sdk/v2";

type AnyEvent = EventV1 | EventV2;
type ContextResponse = { context?: string };
type SessionIdPayload = { sessionID?: string };
type SessionInfoPayload = {
  id?: string;
  title?: unknown;
  parentID?: unknown;
  version?: unknown;
  summary?: {
    additions?: number;
    deletions?: number;
    files?: unknown;
  };
};
type MessageTimePayload = { created?: number; completed?: number };
type MessageInfoPayload = {
  id?: string;
  parentID?: unknown;
  sessionID?: string;
  role?: string;
  modelID?: unknown;
  providerID?: unknown;
  mode?: unknown;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  error?: unknown;
  finish?: unknown;
  time?: MessageTimePayload;
};
type ToolTimePayload = { start?: number; end?: number };
type TodoPayload = { content?: string; priority?: string; status?: string };
type QuestionOptionPayload = { label?: unknown; description?: unknown };
type QuestionPayload = { question?: unknown; header?: unknown; options?: readonly QuestionOptionPayload[] };
type QuestionToolPayload = { callID?: string; messageID?: string };

const API = env.AGENTMEMORY_URL || "http://localhost:3111";
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);
const FILE_KEYS = ["filePath", "file_path", "path", "file", "pattern"];
const MAX_STASHED_FILES = 20;

const DEBUG = env.OPENCODE_AGENTMEMORY_DEBUG === "1";
const SECRET = env.AGENTMEMORY_SECRET || "";

const TIMEOUT_MS = Number(env.OPENCODE_AGENTMEMORY_TIMEOUT_MS) || 5000;
const HEAVY_TIMEOUT_MS = Number(env.OPENCODE_AGENTMEMORY_HEAVY_TIMEOUT_MS) || 30_000;

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "[::1]",
]);

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) headers["Authorization"] = `Bearer ${SECRET}`;
  return headers;
}

async function post(path: string, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<void> {
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

async function postJson<T = unknown>(path: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? await res.json() as T : null;
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
const startContextCache = new Map<string, string>();

function stashFor(sid: string): Set<string> {
  let s = stashedFiles.get(sid);
  if (!s) { s = new Set<string>(); stashedFiles.set(sid, s); }
  return s;
}

function addToStash(sid: string, file: string | null | undefined): void {
  if (typeof file !== "string" || file.length === 0) return;
  const stash = stashFor(sid);
  stash.add(file);
  if (stash.size > MAX_STASHED_FILES) {
    const keep = [...stash].slice(-MAX_STASHED_FILES);
    stash.clear();
    for (const f of keep) stash.add(f);
  }
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

function safeStringOrNull(v: unknown, max: number): string | null {
  if (v == null) return null;
  return safeSlice(v, max);
}

function stringArrayCappedByJson(values: string[], max: number): string[] {
  const json = safeSlice(values, max);
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {}
  const capped: string[] = [];
  for (const value of values) {
    const next = [...capped, value];
    if (safeSlice(next, max).length !== JSON.stringify(next).length) break;
    capped.push(value);
  }
  return capped;
}

function questionAskedData(
  id: string,
  questions: readonly QuestionPayload[],
  tool?: QuestionToolPayload,
): Record<string, unknown> {
  const first = questions[0];
  const firstOptions: readonly QuestionOptionPayload[] = Array.isArray(first?.options) ? first.options : [];
  const optionsCapped = firstOptions.slice(0, 8).map((opt) => ({
    label: safeStringOrNull(opt?.label, 200),
    description: safeStringOrNull(opt?.description, 500),
  }));
  return {
    question_id: id,
    questions: questions.length,
    header: safeStringOrNull(first?.header, 2000),
    prompt: safeStringOrNull(first?.question, 2000),
    options_count: firstOptions.length,
    options: optionsCapped,
    tool_call_id: tool?.callID ?? null,
    tool_message_id: tool?.messageID ?? null,
  };
}

function questionRepliedData(requestID: string, answers: readonly (readonly string[])[]): Record<string, unknown> {
  const flattened: string[] = [];
  for (const answer of answers) {
    for (const value of answer) {
      flattened.push(safeSlice(value, 2000));
    }
  }
  return {
    request_id: requestID,
    answer_count: answers.length,
    answers: stringArrayCappedByJson(flattened, 4000),
  };
}

function sanitizeOutput(v: unknown): unknown {
  const BASE64_PREFIX_RE = /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|PHN2Z|JVBERi0)/;
  const MAX_DEPTH = 6;
  const MAX_NODES = 5000;
  const stripBlob = (s: string): string => {
    if (s.length <= 100) return s;
    if (s.startsWith("data:image/") || s.startsWith("data:application/") || s.startsWith("data:audio/") || s.startsWith("data:video/")) {
      return `<blob:stripped:${s.length}b>`;
    }
    if (BASE64_PREFIX_RE.test(s)) {
      return `<base64:stripped:${s.length}b>`;
    }
    return s;
  };
  const seen = new WeakSet<object>();
  let nodes = 0;
  const walk = (value: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES) return value;
    if (typeof value === "string") return stripBlob(value);
    if (value == null) return value;
    if (typeof value !== "object") return value;
    if (depth >= MAX_DEPTH) return value;
    if (seen.has(value as object)) return "<circular>";
    seen.add(value as object);
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(val, depth + 1);
    }
    return out;
  };
  return walk(v, 0);
}

function assertHttpsOrLoopback(): void {
  if (!SECRET) return;
  try {
    const u = new URL(API);
    if (u.protocol === "http:" && !LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) {
      console.warn(
        `[agentmemory] AGENTMEMORY_SECRET is set but AGENTMEMORY_URL is plaintext http to a non-loopback host (${API}). Use HTTPS or an SSH tunnel to protect the bearer token.`,
      );
    }
  } catch {
    // unparseable URL: leave it to fetch() to surface the error
  }
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

SLOTS (durable cross-session notes):

memory_slot_list: List all memory slots (pinned, project, and global).
  Use when: resuming work, to see what stable context already exists.

memory_slot_get: Read a single slot by label (pending_items, project_context, user_preferences, ...).
  Use when: resuming a session. Read pending_items first to recover unfinished work.

memory_slot_append: Append one line to an existing slot.
  Use when: stopping mid-task. Append a concise line to pending_items describing the unfinished state. Returns 413 if it would exceed the slot size limit; compact via memory_slot_replace first.

memory_slot_replace: Replace a slot's full content in place.
  Use when: compacting a slot that hit its size limit, or rewriting stale content.

Operating loop: on resume, read pending_items to recover unfinished work; when stopping midstream with real unfinished state, append one concise line to pending_items. Slots are stable anchors, not scratchpads; session-local detail belongs in memory_save or memory_lesson_save.

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
  projectPath = ctx.worktree || ctx.project?.id || cwd();

  assertHttpsOrLoopback();

  if (DEBUG) {
    fetch(`${API}/agentmemory/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(2000),
    })
      .then((r) => console.error(`[agentmemory] health probe ${r.status}`))
      .catch((e) => console.error(`[agentmemory] health unreachable:`, (e as Error).message));
  }

  return {
    event: async ({ event: rawEvent }) => {
      const event = rawEvent as AnyEvent;

      // ── session.created ──
      if (event.type === "session.created") {
        const info = event.properties.info as SessionInfoPayload | undefined;
        activeSessionId = info?.id || (event.properties as SessionIdPayload).sessionID || null;
        if (!activeSessionId) return;
        stashedFiles.set(activeSessionId, new Set());
        seenSubtaskIds.delete(activeSessionId);
        seenToolCallIds.delete(activeSessionId);
        contextInjectedSessions.delete(activeSessionId);
        const sessionId = activeSessionId;
        const startResult: ContextResponse | null = await postJson("/session/start", {
          sessionId,
          title: info?.title ?? null,
          parentID: info?.parentID ?? null,
          version: info?.version ?? null,
          project: projectPath,
          cwd: projectPath,
        });
        const startCtx = startResult?.context;
        if (typeof startCtx === "string" && startCtx.length > 0) {
          startContextCache.set(sessionId, startCtx);
        }
        if (pendingConfig) {
          await observe(sessionId, "config_loaded", pendingConfig);
          pendingConfig = null;
        }
      }

      // session.idle (the deprecated v1 bus event) intentionally not handled.
      // SessionStatus.set() publishes session.status first, then session.idle;
      // both fire on the same idle transition. session.status is the typed v2
      // superset (idle/busy/retry). We listen only to session.status to avoid
      // duplicate /session/checkpoint POSTs.
      // ── session.status ──
      if (event.type === "session.status") {
        const status = event.properties.status as { type?: string; attempt?: unknown; message?: unknown } | undefined;
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid || !status) return;
        if (status.type === "idle") {
          await post("/session/checkpoint", { sessionId: sid });
        }
        await observe(sid, "session_status", {
          status_type: status.type,
          attempt: status.attempt ?? null,
          message: safeSlice(status.message, 2000),
        });
      }

      // ── session.compacted ──
      if (event.type === "session.compacted") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (sid) {
          await post("/session/checkpoint", { sessionId: sid });
          await observe(sid, "session_compacted", {});
          contextInjectedSessions.delete(sid);
        }
      }

      // ── session.updated ──
      if (event.type === "session.updated") {
        const info = event.properties.info as SessionInfoPayload | undefined;
        const sid = info?.id || ((event.properties as SessionIdPayload).sessionID ?? activeSessionId);
        if (!sid) return;
        const isResumed = !stashedFiles.has(sid);
        if (isResumed) {
          stashedFiles.set(sid, new Set());
          contextInjectedSessions.delete(sid);
          if (!activeSessionId) activeSessionId = sid;
          const resumeResult: ContextResponse | null = await postJson("/session/start", {
            sessionId: sid,
            title: info?.title ?? null,
            parentID: info?.parentID ?? null,
            project: projectPath,
            cwd: projectPath,
            resumed: true,
          });
          const resumeCtx = resumeResult?.context;
          if (typeof resumeCtx === "string" && resumeCtx.length > 0) {
            startContextCache.set(sid, resumeCtx);
          }
        }
        await observe(sid, "session_updated", {
          title: info?.title ?? null,
          parentID: info?.parentID ?? null,
          additions: info?.summary?.additions ?? null,
          deletions: info?.summary?.deletions ?? null,
          files: info?.summary?.files ?? null,
        });
      }

      // ── session.diff ──
      if (event.type === "session.diff") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid || !Array.isArray(event.properties.diff)) return;
        const diffs = event.properties.diff as Array<Record<string, unknown>>;
        await observe(sid, "session_diff", {
          files: diffs.map(d => d.file),
          additions: diffs.reduce((s, d) => s + ((d.additions as number) || 0), 0),
          deletions: diffs.reduce((s, d) => s + ((d.deletions as number) || 0), 0),
          diffs: diffs.slice(0, 50),
        });
      }

      // ── session.deleted ──
      if (event.type === "session.deleted") {
        const info = event.properties.info as SessionInfoPayload | undefined;
        const sid = info?.id || ((event.properties as SessionIdPayload).sessionID ?? activeSessionId);
        if (!sid) {
          if (DEBUG) console.error("[agentmemory] session.deleted with no session ID");
          return;
        }
        await post("/session/end", { sessionId: sid });
        void post("/crystals/auto", { olderThanDays: 7 }, HEAVY_TIMEOUT_MS);
        void post("/consolidate-pipeline", { tier: "all", force: true }, HEAVY_TIMEOUT_MS);
        if (sid === activeSessionId) activeSessionId = null;
        stashedFiles.delete(sid);
        startContextCache.delete(sid);
        seenSubtaskIds.delete(sid);
        seenToolCallIds.delete(sid);
        contextInjectedSessions.delete(sid);
      }

      // ── session.error ──
      if (event.type === "session.error") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (sid) {
          await observe(sid, "post_tool_failure", {
            tool_name: "session.error",
            tool_input: "",
            tool_output: safeSlice(event.properties.error, 8000),
          });
        }
      }

      // ── message.updated ──
      if (event.type === "message.updated") {
        const info = event.properties.info as MessageInfoPayload | undefined;
        if (!info) return;

        if (info.role === "assistant") {
          const sid = (event.properties as SessionIdPayload).sessionID ?? info.sessionID ?? activeSessionId;
          if (!sid) return;
          const tokens = info.tokens;
          const time = info.time;
          const error = info.error ? extractErrorMessage(info.error) : null;
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
            duration_ms: typeof time?.completed === "number"
              ? time.completed - (time.created || 0)
              : null,
          });
        } else if (info.role === "user") {
          const sid = (event.properties as SessionIdPayload).sessionID ?? info.sessionID ?? activeSessionId;
          if (!sid) return;
          await observe(sid, "user_message", {
            messageID: info.id,
            parentID: info.parentID,
            mode: info.mode ?? null,
            time_created: info.time?.created ?? null,
          });
        }
      }

      // ── message.removed ──
      if (event.type === "message.removed") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (sid) {
          await observe(sid, "message_removed", {
            messageID: event.properties.messageID,
          });
        }
      }

      // ── message.part.removed ──
      if (event.type === "message.part.removed") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (sid) {
          await observe(sid, "message_part_removed", {
            messageID: event.properties.messageID,
            partID: event.properties.partID,
          });
        }
      }

      // ── message.part.updated ──
      if (event.type === "message.part.updated") {
        const part = event.properties.part;
        if (!part) return;
        const sid = part.sessionID ?? (event.properties as SessionIdPayload).sessionID ?? activeSessionId;
        if (!sid) return;

        if (part.type === "subtask") {
          const subtaskId = part.id;
          if (!subtaskId) return;
          const subtaskSet = subtaskSetFor(sid);
          if (subtaskSet.has(subtaskId)) return;
          subtaskSet.add(subtaskId);
          await observe(sid, "subagent_start", {
            subtask_id: part.id,
            agent: part.agent,
            prompt: safeSlice(part.prompt, 4000),
            description: safeSlice(part.description, 2000),
          });
          return;
        }

        if (part.type === "tool") {
          const state = part.state;
          if (!state) return;
          const callId = part.callID;
          if (!callId) return;
          const toolName = part.tool;

          if (state.status === "completed") {
            const callSet = toolCallSetFor(sid);
            if (callSet.has(callId)) return;
            callSet.add(callId);
            const rawTime = state.time as ToolTimePayload | undefined || {};
            const startTime = typeof rawTime.start === "number" ? rawTime.start : null;
            const endTime = typeof rawTime.end === "number" ? rawTime.end : null;
            await observe(sid, "post_tool_use", {
              tool_name: toolName,
              call_id: callId,
              tool_input: safeSlice(state.input, 4000),
              tool_output: safeSlice(sanitizeOutput(state.output), 8000),
              title: state.title ?? null,
              metadata: state.metadata || {},
              duration_ms: (startTime != null && endTime != null) ? endTime - startTime : null,
              attachments: Array.isArray(state.attachments)
                ? state.attachments.map(a => a.filename || a.url)
                : [],
            });
          } else if (state.status === "error") {
            const callSet = toolCallSetFor(sid);
            if (callSet.has(callId)) return;
            callSet.add(callId);
            const rawTime = state.time as ToolTimePayload | undefined || {};
            const startTime = typeof rawTime.start === "number" ? rawTime.start : null;
            const endTime = typeof rawTime.end === "number" ? rawTime.end : null;
            await observe(sid, "post_tool_failure", {
              tool_name: toolName,
              call_id: callId,
              tool_input: safeSlice(state.input, 4000),
              tool_output: safeSlice(sanitizeOutput(state.error), 8000),
              duration_ms: (startTime != null && endTime != null) ? endTime - startTime : null,
            });
          }
          return;
        }

        if (part.type === "step-finish") {
          await observe(sid, "step_finish", {
            messageID: part.messageID,
            reason: part.reason ?? null,
            cost: part.cost ?? 0,
            input_tokens: part.tokens?.input ?? 0,
            output_tokens: part.tokens?.output ?? 0,
            reasoning_tokens: part.tokens?.reasoning ?? 0,
          });
          return;
        }

        if (part.type === "reasoning") {
          await observe(sid, "reasoning", {
            messageID: part.messageID,
            text: safeSlice(part.text, 4000),
          });
          return;
        }

        if (part.type === "file") {
          const filename = part.filename || part.url || null;
          addToStash(sid, filename);
          return;
        }

        if (part.type === "patch") {
          await observe(sid, "patch_applied", {
            messageID: part.messageID,
            hash: part.hash,
            files: part.files || [],
          });
          return;
        }

        if (part.type === "compaction") {
          await observe(sid, "compaction_event", {
            messageID: part.messageID,
            auto: part.auto ?? false,
          });
          return;
        }

        if (part.type === "agent") {
          await observe(sid, "agent_selected", {
            messageID: part.messageID,
            name: part.name,
          });
          return;
        }

        if (part.type === "retry") {
          await observe(sid, "retry_attempt", {
            messageID: part.messageID,
            attempt: part.attempt,
            error: safeSlice(part.error, 2000),
          });
          return;
        }
      }

      // ── file.edited ──
      if (event.type === "file.edited") {
        const sid = (event.properties as SessionIdPayload).sessionID ?? activeSessionId;
        if (sid && typeof event.properties.file === "string" && event.properties.file.length > 0) {
          addToStash(sid, event.properties.file);
        }
      }

      // ── file.watcher.updated ── (external fs change)
      if (event.type === "file.watcher.updated") {
        const sid = activeSessionId;
        if (sid && typeof event.properties.file === "string" && event.properties.file.length > 0) {
          await observe(sid, "file_watcher", {
            file: event.properties.file,
            event: event.properties.event || "change",
          });
        }
      }

      // ── permission.updated ──
      if (event.type === "permission.updated") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid) return;
        await observe(sid, "notification", {
          notification_type: "permission_prompt",
          permission: event.properties.type || "unknown",
          pattern: Array.isArray(event.properties.pattern)
            ? event.properties.pattern.join(", ")
            : (event.properties.pattern || ""),
          tool_call_id: event.properties.callID || null,
          title: event.properties.title || event.properties.type || "",
          metadata: event.properties.metadata || {},
        });
      }

      // ── permission.asked ── (v2 SDK bus event shape)
      if (event.type === "permission.asked") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid) return;
        const tool = event.properties.tool as { messageID?: string; callID?: string } | undefined;
        await observe(sid, "permission_asked", {
          permission_id: event.properties.id || "",
          permission: event.properties.permission || "",
          patterns: Array.isArray(event.properties.patterns) ? event.properties.patterns : [],
          always: Array.isArray(event.properties.always) ? event.properties.always : [],
          tool_call_id: tool?.callID ?? null,
          tool_message_id: tool?.messageID ?? null,
          metadata: event.properties.metadata || {},
        });
      }

      // ── permission.v2.asked ──
      if (event.type === "permission.v2.asked") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid) return;
        await observe(sid, "permission_v2_asked", {
          permission_id: event.properties.id || "",
          action: event.properties.action || "",
          resources: Array.isArray(event.properties.resources) ? event.properties.resources : [],
          save: Array.isArray(event.properties.save) ? event.properties.save : [],
          metadata: event.properties.metadata || {},
        });
      }

      // ── permission.v2.replied ──
      if (event.type === "permission.v2.replied") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid) return;
        await observe(sid, "permission_v2_replied", {
          request_id: event.properties.requestID || "",
          reply: safeSlice(event.properties.reply, 1000),
        });
      }

      // ── permission.replied ──
      if (event.type === "permission.replied") {
        const properties = event.properties as typeof event.properties & {
          permissionID?: string;
          requestID?: string;
          response?: string;
          reply?: string;
        };
        const sid = properties.sessionID ?? activeSessionId;
        if (!sid) return;
        await observe(sid, "permission_replied", {
          permission_id: properties.permissionID || properties.requestID || "",
          response: properties.response || properties.reply || "",
        });
      }

      // ── todo.updated ──
      if (event.type === "todo.updated") {
        const sid = event.properties.sessionID ?? activeSessionId;
        const todos = Array.isArray(event.properties.todos) ? event.properties.todos.slice(0, 100) as TodoPayload[] : [];
        if (!sid || todos.length === 0) return;
        const completed = todos.filter((t) => t.status === "completed");
        const active = todos.filter((t) => t.status !== "completed");
        await observe(sid, "task_completed", {
          completed: completed.map((t) => ({ content: t.content, priority: t.priority })),
          in_progress: active.map((t) => ({ content: t.content, priority: t.priority })),
          total: todos.length,
        });
      }

      // ── vcs.branch.updated ── (git branch switch context)
      if (event.type === "vcs.branch.updated") {
        const sid = activeSessionId;
        if (sid) {
          await observe(sid, "vcs_branch_updated", {
            branch: event.properties.branch || null,
          });
        }
      }

      // ── command.executed ──
      if (event.type === "command.executed") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (sid) {
          await observe(sid, "command_executed", {
            name: event.properties.name,
            arguments: event.properties.arguments || "",
          });
        }
      }

      if (event.type === "lsp.client.diagnostics") {
        const sid = activeSessionId;
        if (!sid) return;
        await observe(sid, "lsp_diagnostics", {
          serverID: event.properties.serverID,
          path: event.properties.path,
        });
      }

      if (event.type === "question.asked") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid) return;
        await observe(sid, "question_asked", questionAskedData(
          event.properties.id,
          event.properties.questions,
          event.properties.tool,
        ));
      }

      if (event.type === "question.replied") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid) return;
        await observe(sid, "question_replied", questionRepliedData(
          event.properties.requestID,
          event.properties.answers,
        ));
      }

      if (event.type === "question.rejected") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid) return;
        await observe(sid, "question_rejected", {
          request_id: event.properties.requestID,
        });
      }

      if (event.type === "question.v2.asked") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid) return;
        await observe(sid, "question_v2_asked", questionAskedData(
          event.properties.id,
          event.properties.questions,
          event.properties.tool,
        ));
      }

      if (event.type === "question.v2.replied") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid) return;
        await observe(sid, "question_v2_replied", questionRepliedData(
          event.properties.requestID,
          event.properties.answers,
        ));
      }

      if (event.type === "question.v2.rejected") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (!sid) return;
        await observe(sid, "question_v2_rejected", {
          request_id: event.properties.requestID,
        });
      }

      if (event.type === "mcp.tools.changed") {
        const sid = activeSessionId;
        if (!sid) return;
        await observe(sid, "mcp_tools_changed", {
          server: event.properties.server,
        });
      }

      if (event.type === "pty.created") {
        const sid = activeSessionId;
        if (!sid) return;
        const info = event.properties.info;
        await observe(sid, "pty_created", {
          pty_id: info.id,
          title: info.title,
          command: info.command,
          args: info.args,
          cwd: info.cwd,
          status: info.status,
          pid: info.pid,
        });
      }

      if (event.type === "pty.exited") {
        const sid = activeSessionId;
        if (!sid) return;
        await observe(sid, "pty_exited", {
          pty_id: event.properties.id,
          exit_code: event.properties.exitCode,
        });
      }

      if (event.type === "mcp.browser.open.failed") {
        const sid = activeSessionId;
        if (!sid) return;
        await observe(sid, "mcp_browser_open_failed", {
          mcp_name: event.properties.mcpName,
          url: safeSlice(event.properties.url, 2000),
        });
      }

      if (event.type === "installation.update-available") {
        const sid = activeSessionId;
        if (!sid) return;
        await observe(sid, "installation_update_available", {
          version: event.properties.version,
        });
      }
    },

    // ── chat.message ──
    "chat.message": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      const parts: Part[] = output.parts || [];
      const files = parts
        .filter((p): p is Extract<Part, { type: "file" }> => p.type === "file")
        .map((p) => p.filename || p.url)
        .filter((file): file is string => typeof file === "string" && file.length > 0);
      for (const f of files) {
        addToStash(sid, f);
      }

      const textParts = parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic && !p.ignored);
      const userText = textParts.map((p) => p.text || "").join("\n");

      await observe(sid, "prompt_submit", {
        agent: input.agent ?? null,
        model: input.model ?? null,
        variant: input.variant ?? null,
        prompt: userText.slice(0, 8000),
        files: files.slice(0, 20),
        parts_summary: parts.map((p) => p.type).filter(Boolean),
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
      for (const fp of extractFilePaths(args)) {
        addToStash(sid, fp);
      }
    },

    // ── tool.execute.after ──
    "tool.execute.after": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      const callId = input.callID;
      if (!callId) return;
      const callSet = toolCallSetFor(sid);
      if (callSet.has(callId)) return;
      callSet.add(callId);
      const args = input.args as Record<string, unknown> | undefined;
      await observe(sid, "post_tool_use", {
        tool_name: input.tool,
        call_id: callId,
        tool_input: safeSlice(args, 4000),
        tool_output: safeSlice(sanitizeOutput(output?.output), 8000),
        title: output?.title ?? null,
        metadata: output?.metadata || {},
        duration_ms: null,
        attachments: [],
      });
    },

    // ── experimental.chat.system.transform ──
    "experimental.chat.system.transform": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;

      if (!contextInjectedSessions.has(sid)) {
        if (!Array.isArray(output.system)) return;
        output.system.push(AGENTMEMORY_INSTRUCTIONS);
        let ctx = startContextCache.get(sid);
        if (typeof ctx !== "string" || ctx.length === 0) {
          const result: ContextResponse | null = await postJson("/context", {
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

      const enrichResult: ContextResponse | null = await postJson("/enrich", {
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

    // ── experimental.chat.messages.transform ──
    // SDK shape: input is {}, output has messages[]. No sessionID on input;
    // observe against activeSessionId when present.
    "experimental.chat.messages.transform": async (_input, output) => {
      const sid = activeSessionId;
      if (!sid) return;
      const msgs = output?.messages;
      const msgCount = Array.isArray(msgs) ? msgs.length : 0;
      await observe(sid, "messages_transform", {
        message_count: msgCount,
      });
    },

    // ── experimental.session.compacting (WIP) ──
    "experimental.session.compacting": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;

      const result: ContextResponse | null = await postJson("/context", {
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

    "experimental.compaction.autocontinue": async (input, output) => {
      const enabled = output.enabled;
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      await observe(sid, "compaction_autocontinue", {
        agent: input.agent,
        model_id: `${input.model.providerID}/${input.model.id}`,
        overflow: input.overflow,
        enabled,
      });
    },

    // ── command.execute.before ──
    // SDK shape: input has {command, sessionID, arguments}, output has {parts}.
    "command.execute.before": async (input, _output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      await observe(sid, "command_before", {
        command: input.command,
        arguments: safeSlice(input.arguments, 2000),
      });
    },

    // ── dispose ──
    // Fires on plugin reload, NOT on session end. The OpenCode session
    // is still alive; resetting in-process state is the entire contract.
    // Posting /session/end here would mark a live session as completed
    // and re-trigger the consolidation pipeline incorrectly.
    dispose: async () => {
      if (activeSessionId) {
        void post("/session/checkpoint", { sessionId: activeSessionId });
      }
      stashedFiles.clear();
      seenSubtaskIds.clear();
      seenToolCallIds.clear();
      contextInjectedSessions.clear();
      startContextCache.clear();
      activeSessionId = null;
      pendingConfig = null;
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
