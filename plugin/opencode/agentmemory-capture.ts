/// <reference types="node" />
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { env } from "node:process";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
const API = normalizeApiUrl(env.AGENTMEMORY_URL || "http://localhost:3111");

const DEBUG = env.OPENCODE_AGENTMEMORY_DEBUG === "1";
const SECRET = env.AGENTMEMORY_SECRET || "";
const PENDING_COMMIT_OUTBOX_VERSION = 1;
const OUTBOX_DESTINATION_FINGERPRINT = destinationFingerprint(API, SECRET);

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

type PendingCommitCheck = {
  readonly marker: string;
  readonly cwd: string;
  readonly knownRefTips: readonly string[];
  readonly baselineAvailable: boolean;
  ready: boolean;
  completionOrder?: number;
};

type QueuedCommit = {
  readonly cwd: string;
  readonly sha: string;
  readonly detail: string;
  readonly knownRefTips: readonly string[];
  readonly baselineAvailable: boolean;
  readonly completionOrder: number;
  readonly reflogTimestamp: number;
  readonly branch?: string;
};

type PendingCommitPost = {
  readonly version: typeof PENDING_COMMIT_OUTBOX_VERSION;
  readonly destinationFingerprint: string;
  readonly sessionId: string;
  readonly metadata: GitCommitMetadata;
  readonly order?: number;
};

type PendingCommitFile = {
  readonly path: string;
  readonly entry: PendingCommitPost;
};

const GIT_TIMEOUT_MS = 500;

function pendingCommitOutboxDir(): string {
  const stateDir = env.OPENCODE_AGENTMEMORY_STATE_DIR?.trim() || join(homedir(), ".agentmemory");
  return join(stateDir, "opencode-pending-commits");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeApiUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function credentialIdentity(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function destinationFingerprint(apiUrl: string, secret: string): string {
  return createHash("sha256")
    .update(`agentmemory-opencode-outbox-v${PENDING_COMMIT_OUTBOX_VERSION}\u0000${apiUrl}\u0000${credentialIdentity(secret)}`)
    .digest("hex");
}

function isPendingCommitPost(value: unknown): value is PendingCommitPost {
  if (!isRecord(value)) return false;
  const entry = value;
  const metadata = entry["metadata"];
  if (
    entry["version"] !== PENDING_COMMIT_OUTBOX_VERSION ||
    typeof entry["destinationFingerprint"] !== "string" ||
    typeof entry["sessionId"] !== "string" ||
    !isRecord(metadata)
  ) {
    return false;
  }
  const commit = metadata;
  return typeof commit["sha"] === "string" &&
    (commit["branch"] === undefined || typeof commit["branch"] === "string") &&
    (commit["repo"] === undefined || typeof commit["repo"] === "string") &&
    typeof commit["message"] === "string" &&
    typeof commit["author"] === "string" &&
    typeof commit["authoredAt"] === "string" &&
    (entry["order"] === undefined || typeof entry["order"] === "number") &&
    Array.isArray(commit["files"]) && commit["files"].every((file) => typeof file === "string");
}

function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function pendingCommitOutboxPath(entry: PendingCommitPost): string {
  const key = `${entry.destinationFingerprint}\u0000${entry.sessionId}\u0000${entry.metadata.sha}`;
  return join(pendingCommitOutboxDir(), `${createHash("sha256").update(key).digest("hex")}.json`);
}

function readPendingCommitOutbox(): PendingCommitFile[] | null {
  const dir = pendingCommitOutboxDir();
  let filenames: string[];
  try {
    filenames = readdirSync(dir).filter((filename) => filename.endsWith(".json")).sort();
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return [];
    if (DEBUG) console.error("[agentmemory] failed to read pending commit outbox:", error);
    return null;
  }
  const pending: PendingCommitFile[] = [];
  for (const filename of filenames) {
    const path = join(dir, filename);
    try {
      const entry: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (isPendingCommitPost(entry)) pending.push({ path, entry });
    } catch (error) {
      if (!errorHasCode(error, "ENOENT") && DEBUG) {
        console.error("[agentmemory] failed to read pending commit outbox entry:", error);
      }
    }
  }
  return pending.sort((left, right) =>
    (left.entry.order ?? 0) - (right.entry.order ?? 0) || left.path.localeCompare(right.path)
  );
}

function enqueuePendingCommit(entry: PendingCommitPost): boolean {
  const dir = pendingCommitOutboxDir();
  const path = pendingCommitOutboxPath(entry);
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(entry), { encoding: "utf-8", flag: "wx", mode: 0o600 });
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if (errorHasCode(error, "EEXIST") && existsSync(path)) return true;
    if (DEBUG) console.error("[agentmemory] failed to enqueue pending commit:", error);
    return false;
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if (!errorHasCode(error, "ENOENT") && DEBUG) {
        console.error("[agentmemory] failed to remove pending commit temporary file:", error);
      }
    }
  }
}

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

function sanitizeRepoUrl(repo: string): string {
  try {
    const url = new URL(repo);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return repo
      .replace(/[?#].*$/, "")
      .replace(/^(\w+:\/\/)[^@/]+@/, "$1")
      .replace(/^[^@/:]+@(?=[^/:]+:)/, "");
  }
}

function collectGitCommitMetadata(cwd: string, sha: string, branch?: string): GitCommitMetadata | null {
  const repoRaw = tryGit(cwd, ["remote", "get-url", "origin"]);
  const repo = repoRaw ? sanitizeRepoUrl(repoRaw) : repoRaw;
  const details = tryGit(cwd, ["show", "-s", "--format=%s%x00%an%x00%aI", sha]);
  const filesOutput = tryGit(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  if (details === null || filesOutput === null) return null;

  const [message, author, authoredAt] = details.split("\u0000");
  if (message === undefined || author === undefined || authoredAt === undefined) return null;

  return {
    sha,
    ...(branch ? { branch } : {}),
    ...(repo ? { repo } : {}),
    message,
    author,
    authoredAt,
    files: filesOutput.split("\n").filter(Boolean),
  };
}

function commitActionDetail(action: string, marker: string): string | null {
  if (action === marker || action === `${marker}:`) return null;
  if (action.startsWith(`${marker} (start):`) || action.startsWith(`${marker} (finish):`)) return null;
  const isRebaseCommit = [
    "pick",
    "reword",
    "edit",
    "squash",
    "fixup",
    "continue",
    "merge",
  ]
    .some((kind) => action.startsWith(`${marker} (${kind}):`));
  if (!action.startsWith(`${marker}:`) && !isRebaseCommit) return null;
  return action.slice(action.indexOf(":") + 1).trim() || null;
}

function branchFromReflogSelector(selector: string): string | null {
  const match = selector.match(/^refs\/heads\/(.+)@\{[^}]+\}$/);
  return match?.[1] || null;
}

function reflogTimestampFromSelector(selector: string | undefined): number {
  const match = selector?.match(/@\{(\d+)\}$/);
  return match ? Number(match[1]) : 0;
}

function collectGitBaseline(cwd: string): { cwd: string; knownRefTips: string[]; available: boolean } {
  const output = tryGit(cwd, ["rev-parse", "--show-toplevel", "HEAD", "--all"]);
  if (output === null) return { cwd, knownRefTips: [], available: false };
  const [repositoryRoot, ...tips] = output.split("\n").filter(Boolean);
  return {
    cwd: repositoryRoot || cwd,
    knownRefTips: [...new Set(tips)],
    available: true,
  };
}

function collectCreatedCommits(cwd: string, checks: readonly PendingCommitCheck[]): QueuedCommit[] | null {
  const markers = checks.map((check) => check.marker);
  const checksByMarker = new Map(checks.map((check) => [check.marker, check]));
  const grepArgs = markers.map((marker) => `--grep-reflog=^${marker}`);
  const output = tryGit(cwd, [
    "reflog",
    "show",
    "--date=unix",
    "--format=%H%x00%gs%x00%gD",
    ...grepArgs,
    "HEAD",
  ]);
  if (output === null) return null;

  const branchOutput = tryGit(cwd, [
    "reflog",
    "show",
    "--all",
    "--date=unix",
    "--format=%H%x00%gs%x00%gD",
    ...grepArgs,
  ]);
  const branches = new Map<string, string>();
  for (const line of branchOutput?.split("\n") ?? []) {
    const [sha, action, selector] = line.split("\u0000");
    if (!sha || !action || !selector) continue;
    const branch = branchFromReflogSelector(selector);
    if (branch) branches.set(`${sha}\u0000${action}`, branch);
  }

  const seen = new Set<string>();
  const commits: QueuedCommit[] = [];
  for (const line of output.split("\n").reverse()) {
    const [sha, action, selector] = line.split("\u0000");
    if (!sha || !action) continue;
    const marker = markers.find((candidate) =>
      action === candidate || action.startsWith(`${candidate}:`) || action.startsWith(`${candidate} (`)
    );
    if (!marker || seen.has(sha)) continue;
    const detail = commitActionDetail(action, marker);
    if (!detail) continue;
    const check = checksByMarker.get(marker)!;
    const branch = branches.get(`${sha}\u0000${action}`);
    seen.add(sha);
    commits.push({
      cwd,
      sha,
      detail,
      knownRefTips: check.knownRefTips,
      baselineAvailable: check.baselineAvailable,
      completionOrder: check.completionOrder ?? Number.MAX_SAFE_INTEGER,
      reflogTimestamp: reflogTimestampFromSelector(selector),
      ...(branch ? { branch } : {}),
    });
  }
  return commits;
}

function wasReachableBeforeTool(cwd: string, sha: string, tips: readonly string[]): boolean | null {
  let unknown = false;
  for (const tip of tips) {
    try {
      runGit(cwd, ["merge-base", "--is-ancestor", sha, tip]);
      return true;
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: unknown }).status
        : undefined;
      if (status !== 1) unknown = true;
    }
  }
  return unknown ? null : false;
}

function isRefMovement(commit: QueuedCommit, commitSubject: string): boolean {
  const movementDetail = commit.detail === "updating HEAD" ||
    commit.detail.startsWith("Fast-forward") ||
    commit.detail.startsWith("moving from ");
  if (!movementDetail) return false;
  if (commit.detail !== commitSubject || !commit.baselineAvailable) return true;
  return wasReachableBeforeTool(commit.cwd, commit.sha, commit.knownRefTips) !== false;
}

function mergeCommitGroups(groups: QueuedCommit[][]): QueuedCommit[] {
  const merged: QueuedCommit[] = [];
  while (groups.some((group) => group.length > 0)) {
    let nextGroup = -1;
    for (let index = 0; index < groups.length; index++) {
      const candidate = groups[index]?.[0];
      if (!candidate) continue;
      const current = nextGroup < 0 ? undefined : groups[nextGroup]?.[0];
      if (!current || candidate.reflogTimestamp < current.reflogTimestamp ||
        (candidate.reflogTimestamp === current.reflogTimestamp &&
          candidate.completionOrder < current.completionOrder)) {
        nextGroup = index;
      }
    }
    merged.push(groups[nextGroup]!.shift()!);
  }
  return merged;
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

function flushPendingCommitOutbox(): Promise<boolean> {
  return (async () => {
    const pending = readPendingCommitOutbox();
    if (!pending) return false;
    let allPosted = true;
    for (const { path, entry } of pending) {
      if (entry.destinationFingerprint !== OUTBOX_DESTINATION_FINGERPRINT) {
        allPosted = false;
        continue;
      }
      const metadata = entry.metadata.repo === undefined
        ? entry.metadata
        : { ...entry.metadata, repo: sanitizeRepoUrl(entry.metadata.repo) };
      if (!await postOk("/session/commit", { ...metadata, sessionId: entry.sessionId })) {
        allPosted = false;
        continue;
      }
      try {
        unlinkSync(path);
      } catch (error) {
        if (!errorHasCode(error, "ENOENT")) {
          if (DEBUG) console.error("[agentmemory] failed to remove pending commit:", error);
          allPosted = false;
        }
      }
    }
    return allPosted;
  })();
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


export const AgentmemoryCapturePlugin: Plugin = async (pluginInput) => {
  const sessionCwd = pluginInput?.directory || process.cwd();
  const projectPath = resolveProject(sessionCwd);
  let activeSessionId: string | null = null;
  const seenSessions = new Set<string>();
  const seenSubtaskIds = new Map<string, Set<string>>();
  const seenToolCallIds = new Map<string, Set<string>>();
  const contextInjectedSessions = new Set<string>();
  const startContextCache = new Map<string, string>();
  const pendingCommitChecks = new Map<string, Map<string, PendingCommitCheck>>();
  const pendingCommitQueues = new Map<string, QueuedCommit[]>();
  const commitCheckChains = new Map<string, Promise<void>>();
  let nextCommitCompletionOrder = 0;
  let nextPendingCommitOrder = 0;

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

  function commitChecksFor(sessionId: string): Map<string, PendingCommitCheck> {
    let checks = pendingCommitChecks.get(sessionId);
    if (!checks) {
      checks = new Map();
      pendingCommitChecks.set(sessionId, checks);
    }
    return checks;
  }

  async function flushCommitQueue(sessionId: string): Promise<boolean> {
    const queue = pendingCommitQueues.get(sessionId);
    if (queue) {
      while (queue.length > 0) {
        const commit = queue[0];
        if (!commit) return false;
        const metadata = collectGitCommitMetadata(commit.cwd, commit.sha, commit.branch);
        if (!metadata) return false;
        if (!isRefMovement(commit, metadata.message) && !enqueuePendingCommit({
          version: PENDING_COMMIT_OUTBOX_VERSION,
          destinationFingerprint: OUTBOX_DESTINATION_FINGERPRINT,
          sessionId,
          metadata,
          order: ++nextPendingCommitOrder,
        })) {
          return false;
        }
        queue.shift();
      }
      pendingCommitQueues.delete(sessionId);
    }
    return flushPendingCommitOutbox();
  }

  async function linkPendingCommits(sessionId: string): Promise<void> {
    await flushCommitQueue(sessionId);
    const checks = pendingCommitChecks.get(sessionId);
    if (!checks) return;

    const readyChecksByCwd = new Map<string, Array<[string, PendingCommitCheck]>>();
    for (const [callId, check] of checks) {
      if (!check.ready) continue;
      const cwdChecks = readyChecksByCwd.get(check.cwd) ?? [];
      cwdChecks.push([callId, check]);
      readyChecksByCwd.set(check.cwd, cwdChecks);
    }

    const groups: QueuedCommit[][] = [];
    for (const [cwd, cwdChecks] of readyChecksByCwd) {
      const commits = collectCreatedCommits(cwd, cwdChecks.map(([, check]) => check));
      if (commits === null) continue;
      groups.push(commits);
      for (const [callId] of cwdChecks) checks.delete(callId);
    }
    if (checks.size === 0) pendingCommitChecks.delete(sessionId);
    const commits = mergeCommitGroups(groups);
    if (commits.length === 0) return;
    const queue = pendingCommitQueues.get(sessionId) ?? [];
    queue.push(...commits);
    pendingCommitQueues.set(sessionId, queue);
    await flushCommitQueue(sessionId);
  }

  function enqueueCommitCheck(sessionId: string, callId: string): Promise<void> {
    const check = pendingCommitChecks.get(sessionId)?.get(callId);
    if (!check) return Promise.resolve();
    if (!check.ready) {
      check.ready = true;
      check.completionOrder = ++nextCommitCompletionOrder;
    }
    const previous = commitCheckChains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => linkPendingCommits(sessionId)).finally(() => {
      if (commitCheckChains.get(sessionId) === next) commitCheckChains.delete(sessionId);
    });
    commitCheckChains.set(sessionId, next);
    return next;
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
        seenSessions.add(sessionId);
        seenSubtaskIds.delete(sessionId);
        seenToolCallIds.delete(sessionId);
        contextInjectedSessions.delete(sessionId);
        const startResult: ContextResponse | null = await postJson("/session/start", {
          sessionId,
          title: info?.title ?? null,
          parentID: info?.parentID ?? null,
          version: info?.version ?? null,
          project: projectPath,
          cwd: sessionCwd,
        });
        await flushPendingCommitOutbox();
        const startCtx = startResult?.context;
        if (
          typeof startCtx === "string" &&
          startCtx.length > 0 &&
          !contextInjectedSessions.has(sessionId)
        ) {
          startContextCache.set(sessionId, startCtx);
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
        const isResumed = !seenSessions.has(sid);
        if (isResumed) {
          seenSessions.add(sid);
          contextInjectedSessions.delete(sid);
          if (!activeSessionId) activeSessionId = sid;
          const resumeResult: ContextResponse | null = await postJson("/session/start", {
            sessionId: sid,
            title: info?.title ?? null,
            parentID: info?.parentID ?? null,
            project: projectPath,
            cwd: sessionCwd,
            resumed: true,
          });
          await flushPendingCommitOutbox();
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
        seenSessions.delete(sid);
        startContextCache.delete(sid);
        seenSubtaskIds.delete(sid);
        seenToolCallIds.delete(sid);
        contextInjectedSessions.delete(sid);
        pendingCommitChecks.delete(sid);
        pendingCommitQueues.delete(sid);
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
            await enqueueCommitCheck(sid, callId);
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
            await enqueueCommitCheck(sid, callId);
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
      await enqueueCommitCheck(sid, callId);
    },

    "shell.env": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      const callId = input.callID;
      if (!sid || !callId) return;
      const checks = commitChecksFor(sid);
      let check = checks.get(callId);
      if (!check) {
        const baseline = collectGitBaseline(input.cwd || sessionCwd);
        check = {
          marker: `agentmemory-${randomUUID()}`,
          cwd: baseline.cwd,
          knownRefTips: baseline.knownRefTips,
          baselineAvailable: baseline.available,
          ready: false,
        };
        checks.set(callId, check);
      }
      output.env.GIT_REFLOG_ACTION = check.marker;
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
      seenSessions.clear();
      seenSubtaskIds.clear();
      seenToolCallIds.clear();
      contextInjectedSessions.clear();
      startContextCache.clear();
      pendingCommitChecks.clear();
      pendingCommitQueues.clear();
      commitCheckChains.clear();
      activeSessionId = null;
    },
  };
};
