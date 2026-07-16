/// <reference types="node" />
import { basename, resolve } from "node:path";
import { env } from "node:process";
import { execFileSync } from "node:child_process";
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
type ToolTimePayload = { start?: number; end?: number };
type TodoPayload = { content?: string; priority?: string; status?: string };
type QuestionOptionPayload = { label?: unknown; description?: unknown };
type QuestionPayload = { question?: unknown; header?: unknown; options?: readonly QuestionOptionPayload[] };
type QuestionToolPayload = { callID?: string; messageID?: string };
const API = env.AGENTMEMORY_URL || "http://localhost:3111";
const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);
const FILE_PATH_KEYS: Record<string, readonly string[]> = {
  read: ["filePath", "file_path", "path", "file"],
  write: ["filePath", "file_path", "path", "file"],
  edit: ["filePath", "file_path", "path", "file"],
  glob: ["path"],
  grep: ["path"],
};
const MAX_STASHED_FILES = 20;

const DEBUG = env.OPENCODE_AGENTMEMORY_DEBUG === "1";
const SECRET = env.AGENTMEMORY_SECRET || "";

const TIMEOUT_MS = Number(env.OPENCODE_AGENTMEMORY_TIMEOUT_MS) || 5000;

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "[::1]",
]);

// OpenCode invokes every runtime export as a plugin factory, so these helpers
// must stay private and inline in the single installed plugin file.
type GitCommitMetadata = {
  readonly sha: string;
  readonly branch?: string;
  readonly repo?: string;
  readonly message: string;
  readonly author: string;
  readonly authoredAt: string;
  readonly files: readonly string[];
};

const GIT_TIMEOUT_MS = 500;

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  }).toString().trim();
}

function tryGit(cwd: string, args: readonly string[]): string | null {
  try {
    return runGit(cwd, args);
  } catch (error) {
    if (DEBUG) {
      console.error(
        `[agentmemory] git ${args.join(" ")} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
}

// Strip embedded credentials (https://user:TOKEN@host/…) from a remote URL
// before it leaves the machine. scp-style git@host:path URLs carry no userinfo
// and pass through unchanged.
function sanitizeRepoUrl(repo: string): string {
  try {
    const url = new URL(repo);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return repo.replace(/^(\w+:\/\/)[^@/]+@/, "$1");
  }
}

function collectGitCommitMetadata(cwd: string, sha: string): GitCommitMetadata | null {
  const branchOutput = tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchOutput === null) return null;
  const repoRaw = tryGit(cwd, ["remote", "get-url", "origin"]);
  const repo = repoRaw ? sanitizeRepoUrl(repoRaw) : repoRaw;
  const details = tryGit(cwd, ["show", "-s", "--format=%s%x00%an%x00%aI", sha]);
  const filesOutput = tryGit(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  if (details === null || filesOutput === null) return null;

  const [message, author, authoredAt] = details.split("\u0000");
  if (message === undefined || author === undefined || authoredAt === undefined) return null;

  return {
    sha,
    ...(branchOutput === "HEAD" ? {} : { branch: branchOutput }),
    ...(repo ? { repo } : {}),
    message,
    author,
    authoredAt,
    files: filesOutput.split("\n").filter(Boolean),
  };
}

// Resolver intentionally duplicated from src/hooks/_project.ts. The plugin file is copied standalone into ~/.config/opencode/plugins/ by 'agentmemory connect opencode --with-plugin' and cannot import from src/. Keep both copies behaviorally identical; parity enforced by test/_fixtures/project-resolver-scenarios.ts.
function resolveProject(cwd?: string): string {
  const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
  if (explicit && explicit.trim()) return explicit.trim();
  const dir = cwd && cwd.trim() ? cwd : process.cwd();
  try {
    const top = gitRevParse(dir, "--show-toplevel");
    const gitDir = gitRevParse(dir, "--git-dir");
    const commonDir = gitRevParse(dir, "--git-common-dir");
    const root =
      resolve(dir, gitDir) === resolve(dir, commonDir)
        ? top
        : resolve(dir, commonDir, "..");
    if (root) return basename(root);
  } catch {}
  return basename(dir);
}

function gitRevParse(cwd: string, arg: string): string {
  return runGit(cwd, ["rev-parse", arg]);
}

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

// Like post(), but reports whether the request actually succeeded (HTTP 2xx and
// no transport error). Callers that advance a cursor on success must use this so a
// transient failure can be retried instead of silently swallowed.
async function postOk(path: string, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch (e) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (e as Error).message);
    return false;
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
    if (++nodes > MAX_NODES) return "<truncated:max-nodes>";
    if (typeof value === "string") return stripBlob(value);
    if (value == null) return value;
    if (typeof value !== "object") return value;
    if (depth >= MAX_DEPTH) return "<truncated:max-depth>";
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

function extractFilePaths(tool: string, args: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const key of FILE_PATH_KEYS[tool] ?? []) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      files.push(val);
    }
  }
  return files;
}

export const AgentmemoryCapturePlugin: Plugin = async (pluginInput) => {
  const sessionCwd = pluginInput?.directory || process.cwd();
  const projectPath = resolveProject(sessionCwd);
  let activeSessionId: string | null = null;
  const stashedFiles = new Map<string, Set<string>>();
  const seenSubtaskIds = new Map<string, Set<string>>();
  const seenToolCallIds = new Map<string, Set<string>>();
  const contextInjectedSessions = new Set<string>();
  const startContextCache = new Map<string, string>();
  const lastSeenHeads = new Map<string, string>();
  const commitCheckChains = new Map<string, Promise<void>>();

  async function observe(
    sessionId: string,
    hookType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await post("/observe", {
      hookType,
      sessionId,
      project: projectPath,
      cwd: sessionCwd,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  function seedSessionHead(sessionId: string): void {
    const head = tryGit(sessionCwd, ["rev-parse", "HEAD"]);
    if (head) lastSeenHeads.set(sessionId, head);
    else lastSeenHeads.delete(sessionId);
  }

  async function linkCommitIfHeadChanged(sessionId: string): Promise<void> {
    const head = tryGit(sessionCwd, ["rev-parse", "HEAD"]);
    if (!head) return;

    const previousHead = lastSeenHeads.get(sessionId);
    if (!previousHead) {
      lastSeenHeads.set(sessionId, head);
      return;
    }
    if (head === previousHead) return;

    const metadata = collectGitCommitMetadata(sessionCwd, head);
    // Metadata collection failed (transient git error): leave the cursor so the next
    // tool completion retries rather than permanently skipping this commit.
    if (!metadata) return;
    // Only advance the cursor when the POST landed. A transient network/5xx failure
    // leaves lastSeenHeads unchanged so the next tool completion retries the link.
    const posted = await postOk("/session/commit", { ...metadata, sessionId });
    if (posted) lastSeenHeads.set(sessionId, head);
  }

  function enqueueCommitCheck(sessionId: string): Promise<void> {
    const previous = commitCheckChains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => linkCommitIfHeadChanged(sessionId)).finally(() => {
      if (commitCheckChains.get(sessionId) === next) commitCheckChains.delete(sessionId);
    });
    commitCheckChains.set(sessionId, next);
    return next;
  }

  function stashFor(sid: string): Set<string> {
    let stash = stashedFiles.get(sid);
    if (!stash) {
      stash = new Set<string>();
      stashedFiles.set(sid, stash);
    }
    return stash;
  }

  function addToStash(sid: string, file: string | null | undefined): void {
    if (typeof file !== "string" || file.length === 0) return;
    const stash = stashFor(sid);
    stash.add(file);
    if (stash.size > MAX_STASHED_FILES) {
      const keep = [...stash].slice(-MAX_STASHED_FILES);
      stash.clear();
      for (const keptFile of keep) stash.add(keptFile);
    }
  }

  function subtaskSetFor(sid: string): Set<string> {
    let ids = seenSubtaskIds.get(sid);
    if (!ids) {
      ids = new Set<string>();
      seenSubtaskIds.set(sid, ids);
    }
    return ids;
  }

  function toolCallSetFor(sid: string): Set<string> {
    let ids = seenToolCallIds.get(sid);
    if (!ids) {
      ids = new Set<string>();
      seenToolCallIds.set(sid, ids);
    }
    return ids;
  }

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
        const sessionId = info?.id || (event.properties as SessionIdPayload).sessionID;
        if (!sessionId) return;
        if (!info?.parentID || !activeSessionId) activeSessionId = sessionId;
        stashedFiles.set(sessionId, new Set());
        seenSubtaskIds.delete(sessionId);
        seenToolCallIds.delete(sessionId);
        contextInjectedSessions.delete(sessionId);
        seedSessionHead(sessionId);
        const startResult: ContextResponse | null = await postJson("/session/start", {
          sessionId,
          title: info?.title ?? null,
          parentID: info?.parentID ?? null,
          version: info?.version ?? null,
          project: projectPath,
          cwd: sessionCwd,
        });
        const startCtx = startResult?.context;
        if (
          typeof startCtx === "string" &&
          startCtx.length > 0 &&
          !contextInjectedSessions.has(sessionId)
        ) {
          startContextCache.set(sessionId, startCtx);
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
      }

      // ── session.compacted ──
      if (event.type === "session.compacted") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (sid) {
          contextInjectedSessions.delete(sid);
          await post("/session/checkpoint", { sessionId: sid });
          await observe(sid, "session_compacted", {});
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
          seedSessionHead(sid);
          const resumeResult: ContextResponse | null = await postJson("/session/start", {
            sessionId: sid,
            title: info?.title ?? null,
            parentID: info?.parentID ?? null,
            project: projectPath,
            cwd: sessionCwd,
            resumed: true,
          });
          const resumeCtx = resumeResult?.context;
          if (
            typeof resumeCtx === "string" &&
            resumeCtx.length > 0 &&
            !contextInjectedSessions.has(sid)
          ) {
            startContextCache.set(sid, resumeCtx);
          }
        }
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
        if (sid === activeSessionId) activeSessionId = null;
        stashedFiles.delete(sid);
        startContextCache.delete(sid);
        seenSubtaskIds.delete(sid);
        seenToolCallIds.delete(sid);
        contextInjectedSessions.delete(sid);
        lastSeenHeads.delete(sid);
        commitCheckChains.delete(sid);
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

      // ── message.removed ──
      if (event.type === "message.removed") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (sid) {
          await observe(sid, "message_removed", {
            messageID: event.properties.messageID,
          });
        }
      }

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

        if (part.type === "text") {
          if (typeof part.time?.end !== "number") return;
          await observe(sid, "assistant_message", {
            messageID: part.messageID,
            partID: part.id,
            message: safeSlice(part.text, 8000),
          });
          return;
        }

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
            await enqueueCommitCheck(sid);
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
            partID: part.id,
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
            partID: part.id,
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
            partID: part.id,
            hash: part.hash,
            files: part.files || [],
          });
          return;
        }

        if (part.type === "compaction") {
          await observe(sid, "compaction_event", {
            messageID: part.messageID,
            partID: part.id,
            auto: part.auto ?? false,
          });
          return;
        }

        if (part.type === "agent") {
          await observe(sid, "agent_selected", {
            messageID: part.messageID,
            partID: part.id,
            name: part.name,
          });
          return;
        }

        if (part.type === "retry") {
          await observe(sid, "retry_attempt", {
            messageID: part.messageID,
            partID: part.id,
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

      if (event.type === "vcs.branch.updated") {
        const sid = activeSessionId;
        if (sid) {
          await observe(sid, "vcs_branch_updated", {
            branch: event.properties.branch || null,
          });
        }
      }

      if (event.type === "command.executed") {
        const sid = event.properties.sessionID ?? activeSessionId;
        if (sid) {
          await observe(sid, "command_executed", {
            name: event.properties.name,
            arguments: event.properties.arguments || "",
          });
          await enqueueCommitCheck(sid);
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
        message_id: input.messageID ?? output.message?.id ?? null,
        agent: input.agent ?? null,
        model: input.model ?? null,
        variant: input.variant ?? null,
        prompt: userText.slice(0, 8000),
        files: files.slice(0, 20),
        parts_summary: parts.map((p) => p.type).filter(Boolean),
      });
    },

    // ── tool.execute.before ──
    "tool.execute.before": async (input, output) => {
      const tool = input.tool.toLowerCase();
      if (!FILE_TOOLS.has(tool)) return;
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      const args = output.args as Record<string, unknown> | undefined;
      if (!args) return;
      for (const fp of extractFilePaths(tool, args)) {
        addToStash(sid, fp);
      }
    },

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
      await enqueueCommitCheck(sid);
    },

    // ── experimental.chat.system.transform ──
    "experimental.chat.system.transform": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;

      if (!contextInjectedSessions.has(sid)) {
        if (!Array.isArray(output.system)) return;
        let ctx = startContextCache.get(sid);
        let contextLoaded = typeof ctx === "string" && ctx.length > 0;
        if (typeof ctx !== "string" || ctx.length === 0) {
          const result: ContextResponse | null = await postJson("/context", {
            sessionId: sid,
            project: projectPath,
          });
          ctx = result?.context;
          contextLoaded = result !== null;
        } else {
          startContextCache.delete(sid);
        }
        if (typeof ctx === "string" && ctx.length > 0) {
          output.system.push(ctx);
        }
        if (contextLoaded) contextInjectedSessions.add(sid);
      }

      const stash = stashFor(sid);
      if (stash.size === 0) return;
      const files = [...stash].slice(0, 10);

      const enrichResult: ContextResponse | null = await postJson("/enrich", {
        sessionId: sid,
        files,
        toolName: "enrich_inject",
      });

      // Clear processed files on any non-null response (not just non-empty
      // context) so empty-result files do not re-fire /enrich every transform.
      if (enrichResult !== null) {
        for (const f of files) stash.delete(f);
        const enrichCtx = enrichResult.context;
        if (typeof enrichCtx === "string" && enrichCtx.length > 0 && Array.isArray(output.system)) {
          output.system.push(enrichCtx);
        }
      }
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

    // SDK shape: input has {command, sessionID, arguments}, output has {parts}.
    "command.execute.before": async (input, _output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      await observe(sid, "command_before", {
        command: input.command,
        arguments: safeSlice(input.arguments, 2000),
      });
    },

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
      lastSeenHeads.clear();
      commitCheckChains.clear();
      activeSessionId = null;
    },
  };
};
