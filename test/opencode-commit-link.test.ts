import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { createOpencodeClient, type Event, type Session } from "@opencode-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentmemoryCapturePlugin } from "../plugin/opencode/agentmemory-capture";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

type PluginInstance = Awaited<ReturnType<typeof AgentmemoryCapturePlugin>>;
type PostCall = { url: string; body: Record<string, unknown> | null };
type CommitResponseFor = (attempt: number) => Response | Promise<Response>;
type ReflogEntry = {
  sha: string;
  action: (marker: string) => string;
  branch?: string;
  order?: number;
  timestamp?: number;
};

type GitMockOptions = {
  rootForCwd?: (cwd: string) => string;
  knownTipsForCwd?: (cwd: string) => readonly string[];
  wasKnown?: (sha: string, tip: string, cwd: string) => boolean;
  reachabilityFails?: (sha: string, tip: string, cwd: string) => boolean;
  baselineFailsForCwd?: (cwd: string) => boolean;
  reflogFailsForCwd?: (cwd: string) => boolean;
};

const FAKE_SHELL: PluginInput["$"] = () => {
  throw new Error("test shell should not run");
};
FAKE_SHELL.braces = () => [];
FAKE_SHELL.escape = (input) => input;
FAKE_SHELL.env = () => FAKE_SHELL;
FAKE_SHELL.cwd = () => FAKE_SHELL;
FAKE_SHELL.nothrow = () => FAKE_SHELL;
FAKE_SHELL.throws = () => FAKE_SHELL;

const FAKE_CTX: PluginInput = {
  client: createOpencodeClient(),
  project: {
    id: "/tmp/test-worktree",
    worktree: "/tmp/test-worktree",
    time: { created: 0 },
  },
  directory: "/tmp/test-worktree",
  worktree: "/tmp/test-worktree",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost:4096"),
  $: FAKE_SHELL,
};

const SECOND_SHA = "2222222222222222222222222222222222222222";
const THIRD_SHA = "3333333333333333333333333333333333333333";
const FOURTH_SHA = "4444444444444444444444444444444444444444";
const MESSAGE = 'fix: preserve $(touch /tmp/not-executed); "quotes"';

let activePlugin: PluginInstance | null = null;
let commitOutboxDir = "";
let isolatedModuleNonce = 0;

function pendingCommitFiles(): string[] {
  const outbox = join(commitOutboxDir, "opencode-pending-commits");
  if (!existsSync(outbox)) return [];
  return readdirSync(outbox)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => join(outbox, filename));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CapturePluginModule = {
  readonly AgentmemoryCapturePlugin: typeof AgentmemoryCapturePlugin;
};

function isCapturePluginModule(value: unknown): value is CapturePluginModule {
  return isRecord(value) && typeof value["AgentmemoryCapturePlugin"] === "function";
}

async function loadIsolatedPluginModule(): Promise<CapturePluginModule> {
  const url = new URL("../plugin/opencode/agentmemory-capture", import.meta.url);
  url.searchParams.set("isolated-writer", String(++isolatedModuleNonce));
  const module: unknown = await import(url.href);
  if (isCapturePluginModule(module)) return module;
  throw new Error("isolated plugin module did not export AgentmemoryCapturePlugin");
}

function parseRequestBody(body: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof body !== "string") return null;
  const parsed: unknown = JSON.parse(body);
  if (isRecord(parsed)) return parsed;
  throw new Error("expected JSON object request body");
}

function requireHook<T>(hook: T | undefined, name: string): T {
  if (!hook) throw new Error(`missing ${name} hook`);
  return hook;
}

function sessionInfo(id: string): Session {
  return {
    id,
    projectID: "/tmp/test-worktree",
    directory: "/tmp/test-worktree",
    title: "test session",
    version: "1",
    time: { created: 0, updated: 0 },
  };
}

function sessionCreatedEvent(id: string): Event {
  return { type: "session.created", properties: { info: sessionInfo(id) } };
}

function sessionDeletedEvent(id: string): Event {
  return { type: "session.deleted", properties: { info: sessionInfo(id) } };
}

function failedShellEvent(sessionId: string, callId: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `part_${callId}`,
        sessionID: sessionId,
        messageID: `message_${callId}`,
        type: "tool",
        callID: callId,
        tool: "Bash",
        state: {
          status: "error",
          input: { command: "git commit" },
          error: "failed",
          time: { start: 0, end: 0 },
        },
      },
    },
  };
}

async function emitEvent(plugin: PluginInstance, event: Event): Promise<void> {
  return requireHook(plugin.event, "event")({ event });
}

function installFetchMock(
  commitStatusFor?: (attempt: number) => number,
  commitResponseFor?: CommitResponseFor,
): PostCall[] {
  const calls: PostCall[] = [];
  let commitAttempt = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const body = parseRequestBody(init?.body);
    calls.push({ url, body });
    if (url.endsWith("/agentmemory/session/commit")) {
      const attempt = ++commitAttempt;
      if (commitResponseFor) return commitResponseFor(attempt);
      const status = commitStatusFor ? commitStatusFor(attempt) : 200;
      if (status !== 200) return new Response("commit failed", { status });
    }
    return new Response(JSON.stringify({ context: "<test-context>" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
  return calls;
}

function installGitMock(
  entriesFor: (marker: string, attempt: number, cwd: string) => readonly ReflogEntry[],
  repoUrl = "git@example.com:team/repo.git",
  messageForSha: (sha: string) => string = () => MESSAGE,
  activeBranch = "feature/commit-link",
  options: GitMockOptions = {},
): void {
  let reflogAttempt = 0;
  const headEntriesByCwd = new Map<string, Array<ReflogEntry & { actionText: string }>>();
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    const gitArgs = (args ?? []).slice(2);
    const command = gitArgs.join(" ");
    const cwd = String(args?.[1]);
    if (gitArgs[0] === "reflog") {
      if (!gitArgs.includes("--all") && options.reflogFailsForCwd?.(cwd)) {
        throw new Error("reflog unavailable");
      }
      if (gitArgs.includes("--all")) {
        return Buffer.from((headEntriesByCwd.get(cwd) ?? [])
          .filter((entry) => entry.branch)
          .map((entry) => `${entry.sha}\u0000${entry.actionText}\u0000refs/heads/${entry.branch}@{0}`)
          .join("\n"));
      }
      const markers = gitArgs
        .filter((arg): arg is string => typeof arg === "string" && arg.startsWith("--grep-reflog=^"))
        .map((arg) => arg.slice("--grep-reflog=^".length));
      if (markers.length === 0) throw new Error("missing reflog marker");
      const batches = markers.map((marker) => entriesFor(marker, ++reflogAttempt, cwd)
        .map((entry) => ({ ...entry, actionText: entry.action(marker) })));
      const headEntries = batches.some((batch) => batch.some((entry) => entry.order !== undefined))
        ? batches.flat().sort((left, right) => (right.order ?? 0) - (left.order ?? 0))
        : batches.reverse().flat();
      headEntriesByCwd.set(cwd, headEntries);
      return Buffer.from(headEntries
        .map((entry) => entry.timestamp === undefined
          ? `${entry.sha}\u0000${entry.actionText}`
          : `${entry.sha}\u0000${entry.actionText}\u0000HEAD@{${entry.timestamp}}`)
        .join("\n"));
    }
    if (command === "rev-parse --show-toplevel HEAD --all") {
      if (options.baselineFailsForCwd?.(cwd)) throw new Error("baseline unavailable");
      const root = options.rootForCwd?.(cwd) ?? cwd;
      const tips = options.knownTipsForCwd?.(cwd) ?? ["1111111111111111111111111111111111111111"];
      return Buffer.from([root, ...tips].join("\n"));
    }
    if (command.startsWith("merge-base --is-ancestor ")) {
      const sha = gitArgs[2];
      const tip = gitArgs[3];
      if (!sha || !tip) throw new Error("missing merge-base arguments");
      if (options.wasKnown?.(sha, tip, cwd)) return Buffer.from("");
      if (options.reachabilityFails?.(sha, tip, cwd)) throw new Error("merge-base unavailable");
      throw Object.assign(new Error("not an ancestor"), { status: 1 });
    }
    if (command === "rev-parse --abbrev-ref HEAD") return Buffer.from(`${activeBranch}\n`);
    if (command === "remote get-url origin") return Buffer.from(`${repoUrl}\n`);
    if (command.startsWith("show -s --format=")) {
      const sha = gitArgs.at(-1)!;
      return Buffer.from(`${messageForSha(sha)}\u0000Agent Tester\u00002026-07-16T10:00:00+00:00\n`);
    }
    if (command.startsWith("diff-tree --no-commit-id --name-only -r")) {
      return Buffer.from("src/one.ts\ntest/one.test.ts\n");
    }
    throw new Error(`unexpected git command: ${command}`);
  });
}

async function loadPlugin(
  commitStatusFor?: (attempt: number) => number,
  commitResponseFor?: CommitResponseFor,
): Promise<{ plugin: PluginInstance; calls: PostCall[] }> {
  const calls = installFetchMock(commitStatusFor, commitResponseFor);
  const plugin = await AgentmemoryCapturePlugin(FAKE_CTX);
  activePlugin = plugin;
  return { plugin, calls };
}

async function startSession(
  plugin: PluginInstance,
  calls: PostCall[],
  sessionId: string,
  clearCalls = true,
  expectNoCommit = true,
): Promise<void> {
  await emitEvent(plugin, sessionCreatedEvent(sessionId));
  if (expectNoCommit) {
    expect(calls.some((call) => call.url.endsWith("/agentmemory/session/commit"))).toBe(false);
  }
  if (clearCalls) calls.length = 0;
}

async function markShellCall(
  plugin: PluginInstance,
  sessionId: string,
  callId: string,
  cwd = FAKE_CTX.directory,
): Promise<string> {
  const output: { env: Record<string, string> } = { env: {} };
  await requireHook(plugin["shell.env"], "shell.env")({ cwd, sessionID: sessionId, callID: callId }, output);
  const marker = output.env.GIT_REFLOG_ACTION;
  if (!marker) throw new Error("missing reflog marker");
  return marker;
}

async function completeShellCall(plugin: PluginInstance, sessionId: string, callId: string): Promise<void> {
  await requireHook(plugin["tool.execute.after"], "tool.execute.after")(
    { tool: "Bash", sessionID: sessionId, callID: callId, args: { command: "git commit" } },
    { output: "completed", title: "bash", metadata: {} },
  );
}

function commitCalls(calls: readonly PostCall[]): PostCall[] {
  return calls.filter((call) => call.url.endsWith("/agentmemory/session/commit"));
}

describe("OpenCode commit-link capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AGENTMEMORY_PROJECT_NAME", "agentmemory");
    commitOutboxDir = mkdtempSync(join(tmpdir(), "am-opencode-commit-outbox-"));
    vi.stubEnv("OPENCODE_AGENTMEMORY_STATE_DIR", commitOutboxDir);
  });

  afterEach(async () => {
    if (activePlugin?.dispose) await activePlugin.dispose();
    activePlugin = null;
    rmSync(commitOutboxDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns its event hook", async () => {
    installFetchMock();
    const plugin = await AgentmemoryCapturePlugin(FAKE_CTX);
    activePlugin = plugin;
    expect(plugin.event).toEqual(expect.any(Function));
  });

  it("tags each shell tool and posts metadata for its created commit", async () => {
    installGitMock((marker) => [{
      sha: SECOND_SHA,
      action: () => `${marker}: ${MESSAGE}`,
      branch: "feature/commit-link",
    }]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_commit");

    const marker = await markShellCall(plugin, "ses_commit", "call_commit");
    expect(marker).toMatch(/^agentmemory-[0-9a-f-]{36}$/);
    expect(await markShellCall(plugin, "ses_commit", "call_commit")).toBe(marker);
    await completeShellCall(plugin, "ses_commit", "call_commit");

    expect(commitCalls(calls)).toEqual([expect.objectContaining({
      body: {
        sha: SECOND_SHA,
        sessionId: "ses_commit",
        branch: "feature/commit-link",
        repo: "example.com:team/repo.git",
        message: MESSAGE,
        author: "Agent Tester",
        authoredAt: "2026-07-16T10:00:00+00:00",
        files: ["src/one.ts", "test/one.test.ts"],
      },
    })]);
    for (const [file, args, options] of vi.mocked(execFileSync).mock.calls) {
      expect(file).toBe("git");
      expect(args?.slice(0, 2)).toEqual(["-C", FAKE_CTX.directory]);
      expect(options).toMatchObject({ timeout: expect.any(Number) });
    }
  });

  it("reads commit provenance from the shell tool cwd", async () => {
    installGitMock((marker) => [{ sha: SECOND_SHA, action: () => `${marker}: nested` }]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_nested");
    const nestedCwd = "/tmp/test-worktree/packages/nested";

    await markShellCall(plugin, "ses_nested", "call_nested", nestedCwd);
    await completeShellCall(plugin, "ses_nested", "call_nested");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA]);
    for (const [, args] of vi.mocked(execFileSync).mock.calls) {
      expect(args?.slice(0, 2)).toEqual(["-C", nestedCwd]);
    }
  });

  it("posts every commit created by one shell tool in oldest-first order", async () => {
    installGitMock((marker) => [
      { sha: THIRD_SHA, action: () => `${marker}: third` },
      { sha: SECOND_SHA, action: () => `${marker}: second` },
      { sha: SECOND_SHA, action: () => `${marker} (finish): returning to refs/heads/main` },
    ]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_multiple");
    await markShellCall(plugin, "ses_multiple", "call_multiple");
    await completeShellCall(plugin, "ses_multiple", "call_multiple");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, THIRD_SHA]);
  });

  it("links commits created by rebase and ignores its start and finish movements", async () => {
    installGitMock((marker) => [
      { sha: FOURTH_SHA, action: () => `${marker} (finish): returning to refs/heads/topic` },
      { sha: FOURTH_SHA, action: () => `${marker} (merge): recreated merge` },
      { sha: THIRD_SHA, action: () => `${marker} (continue): resolved commit` },
      { sha: SECOND_SHA, action: () => `${marker} (pick): replayed commit` },
      { sha: THIRD_SHA, action: () => `${marker} (start): checkout main` },
    ]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_rebase");
    await markShellCall(plugin, "ses_rebase", "call_rebase");
    await completeShellCall(plugin, "ses_rebase", "call_rebase");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([
      SECOND_SHA,
      THIRD_SHA,
      FOURTH_SHA,
    ]);
  });

  it.each([
    ["checkout", (marker: string) => marker],
    ["reset", (marker: string) => `${marker}: updating HEAD`],
    ["pull", (marker: string) => `${marker}: Fast-forward`],
    ["pull with message", (marker: string) => `${marker}: Fast-forward (no commit created; -m option ignored)`],
    ["checkout detail", (marker: string) => `${marker}: moving from main to topic`],
    ["rebase start", (marker: string) => `${marker} (start): checkout main`],
    ["rebase finish", (marker: string) => `${marker} (finish): returning to refs/heads/topic`],
  ])("does not link a %s HEAD movement", async (_label, action) => {
    installGitMock(() => [{ sha: SECOND_SHA, action }]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_movement");
    await markShellCall(plugin, "ses_movement", "call_movement");
    await completeShellCall(plugin, "ses_movement", "call_movement");
    expect(commitCalls(calls)).toHaveLength(0);
  });

  it("ignores HEAD changes when the completed tool has no owned reflog marker", async () => {
    installGitMock((marker) => [{ sha: SECOND_SHA, action: () => `${marker}: other session` }]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_current");
    await completeShellCall(plugin, "ses_current", "call_without_env");
    expect(commitCalls(calls)).toHaveLength(0);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("links each overlapping shell tool when it settles", async () => {
    installGitMock((marker, attempt) => attempt === 1
      ? [{ sha: SECOND_SHA, action: () => `${marker}: first tool` }]
      : [{ sha: THIRD_SHA, action: () => `${marker}: second tool` }]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_overlap");

    await markShellCall(plugin, "ses_overlap", "call_1");
    await markShellCall(plugin, "ses_overlap", "call_2");
    await completeShellCall(plugin, "ses_overlap", "call_1");
    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA]);

    await completeShellCall(plugin, "ses_overlap", "call_2");
    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, THIRD_SHA]);
  });

  it("keeps completion order for overlapping shell commits", async () => {
    let firstMarker = "";
    let secondMarker = "";
    installGitMock((marker) => marker === firstMarker
      ? [{ sha: THIRD_SHA, action: () => `${marker}: first tool`, order: 2 }]
      : marker === secondMarker
        ? [{ sha: SECOND_SHA, action: () => `${marker}: second tool`, order: 1 }]
        : []);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_reverse_overlap");

    firstMarker = await markShellCall(plugin, "ses_reverse_overlap", "call_1");
    secondMarker = await markShellCall(plugin, "ses_reverse_overlap", "call_2");
    await completeShellCall(plugin, "ses_reverse_overlap", "call_2");
    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA]);

    await completeShellCall(plugin, "ses_reverse_overlap", "call_1");
    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, THIRD_SHA]);
  });

  it("merges overlapping commits from different repositories by reflog time", async () => {
    let firstMarker = "";
    let secondMarker = "";
    installGitMock(
      (marker) => marker === firstMarker
        ? [{ sha: THIRD_SHA, action: () => `${marker}: later`, timestamp: 200 }]
        : marker === secondMarker
          ? [{ sha: SECOND_SHA, action: () => `${marker}: earlier`, timestamp: 100 }]
          : [],
      undefined,
      undefined,
      undefined,
      { rootForCwd: (cwd) => cwd },
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_cross_repo");

    firstMarker = await markShellCall(plugin, "ses_cross_repo", "call_1", "/tmp/repo-a");
    secondMarker = await markShellCall(plugin, "ses_cross_repo", "call_2", "/tmp/repo-b");
    await completeShellCall(plugin, "ses_cross_repo", "call_2");
    await completeShellCall(plugin, "ses_cross_repo", "call_1");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, THIRD_SHA]);
  });

  it("uses completion order for cross-repository reflog timestamp ties", async () => {
    let firstMarker = "";
    let secondMarker = "";
    installGitMock(
      (marker) => marker === firstMarker
        ? [{ sha: THIRD_SHA, action: () => `${marker}: later`, timestamp: 100 }]
        : marker === secondMarker
          ? [{ sha: SECOND_SHA, action: () => `${marker}: earlier`, timestamp: 100 }]
          : [],
      undefined,
      undefined,
      undefined,
      { rootForCwd: (cwd) => cwd },
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_cross_repo_tie");

    firstMarker = await markShellCall(plugin, "ses_cross_repo_tie", "call_1", "/tmp/repo-a");
    secondMarker = await markShellCall(plugin, "ses_cross_repo_tie", "call_2", "/tmp/repo-b");
    await completeShellCall(plugin, "ses_cross_repo_tie", "call_2");
    await completeShellCall(plugin, "ses_cross_repo_tie", "call_1");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, THIRD_SHA]);
  });

  it("merges repository root and subdirectory calls through one reflog", async () => {
    installGitMock(
      (marker, attempt) => [{
        sha: attempt === 1 ? SECOND_SHA : THIRD_SHA,
        action: () => `${marker}: commit`,
      }],
      undefined,
      undefined,
      undefined,
      { rootForCwd: () => "/tmp/repo" },
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_same_repo");
    await markShellCall(plugin, "ses_same_repo", "call_root", "/tmp/repo");
    await markShellCall(plugin, "ses_same_repo", "call_subdir", "/tmp/repo/packages/core");
    await completeShellCall(plugin, "ses_same_repo", "call_root");
    await completeShellCall(plugin, "ses_same_repo", "call_subdir");

    const headReflogCalls = vi.mocked(execFileSync).mock.calls.filter(([, args]) => {
      const gitArgs = args?.slice(2) ?? [];
      return gitArgs[0] === "reflog" && gitArgs.includes("HEAD");
    });
    expect(headReflogCalls).toHaveLength(2);
    for (const [, args] of headReflogCalls) {
      expect(args?.slice(0, 2)).toEqual(["-C", "/tmp/repo"]);
    }
    expect(commitCalls(calls)).toHaveLength(2);
  });

  it("does not let one failed repository block another repository", async () => {
    installGitMock(
      (marker, _attempt, cwd) => cwd === "/tmp/repo-good"
        ? [{ sha: SECOND_SHA, action: () => `${marker}: commit` }]
        : [],
      undefined,
      undefined,
      undefined,
      {
        rootForCwd: (cwd) => cwd,
        reflogFailsForCwd: (cwd) => cwd === "/tmp/repo-bad",
      },
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_failed_repo");
    await markShellCall(plugin, "ses_failed_repo", "call_bad", "/tmp/repo-bad");
    await markShellCall(plugin, "ses_failed_repo", "call_good", "/tmp/repo-good");
    await completeShellCall(plugin, "ses_failed_repo", "call_bad");
    await completeShellCall(plugin, "ses_failed_repo", "call_good");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA]);
  });

  it("uses the branch reflog entry from commit time", async () => {
    installGitMock(
      (marker) => [{
        sha: SECOND_SHA,
        action: () => `${marker}: commit before checkout`,
        branch: "feature/original",
      }],
      undefined,
      undefined,
      "feature/after-checkout",
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_branch");
    await markShellCall(plugin, "ses_branch", "call_branch");
    await completeShellCall(plugin, "ses_branch", "call_branch");

    expect(commitCalls(calls)[0]?.body?.branch).toBe("feature/original");
    expect(vi.mocked(execFileSync).mock.calls.some(([, args]) =>
      args?.slice(2).join(" ") === "rev-parse --abbrev-ref HEAD"
    )).toBe(false);
  });

  it.each([
    "updating HEAD",
    "Fast-forward",
    "Fast-forward release branch",
    "moving from main to topic",
  ])("links a commit whose subject is %s", async (subject) => {
    installGitMock(
      (marker) => [{ sha: SECOND_SHA, action: () => `${marker}: ${subject}` }],
      undefined,
      () => subject,
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_movement_subject");
    await markShellCall(plugin, "ses_movement_subject", "call_movement_subject");
    await completeShellCall(plugin, "ses_movement_subject", "call_movement_subject");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA]);
  });

  it("ignores a reset to an existing commit titled updating HEAD", async () => {
    installGitMock(
      (marker) => [{ sha: SECOND_SHA, action: () => `${marker}: updating HEAD` }],
      undefined,
      () => "updating HEAD",
      undefined,
      { wasKnown: (sha) => sha === SECOND_SHA },
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_existing_movement_subject");
    await markShellCall(plugin, "ses_existing_movement_subject", "call_existing_movement_subject");
    await completeShellCall(plugin, "ses_existing_movement_subject", "call_existing_movement_subject");

    expect(commitCalls(calls)).toHaveLength(0);
  });

  it("rejects ambiguous movement-like provenance when the baseline read failed", async () => {
    installGitMock(
      (marker) => [{ sha: SECOND_SHA, action: () => `${marker}: updating HEAD` }],
      undefined,
      () => "updating HEAD",
      undefined,
      { baselineFailsForCwd: () => true },
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_missing_baseline");
    await markShellCall(plugin, "ses_missing_baseline", "call_missing_baseline");
    await completeShellCall(plugin, "ses_missing_baseline", "call_missing_baseline");

    expect(commitCalls(calls)).toHaveLength(0);
  });

  it("rejects ambiguous movement-like provenance when reachability cannot be checked", async () => {
    installGitMock(
      (marker) => [{ sha: SECOND_SHA, action: () => `${marker}: updating HEAD` }],
      undefined,
      () => "updating HEAD",
      undefined,
      { reachabilityFails: () => true },
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_reachability_error");
    await markShellCall(plugin, "ses_reachability_error", "call_reachability_error");
    await completeShellCall(plugin, "ses_reachability_error", "call_reachability_error");

    expect(commitCalls(calls)).toHaveLength(0);
  });

  it("links a commit created before its shell tool failed", async () => {
    installGitMock(() => [{ sha: SECOND_SHA, action: (marker) => `${marker}: commit` }]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_failed");
    await markShellCall(plugin, "ses_failed", "call_failed");

    await emitEvent(plugin, failedShellEvent("ses_failed", "call_failed"));

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([
      SECOND_SHA,
    ]);
  });

  it("does not post or throw when the reflog read fails", async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("not a git repository"); });
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_git_error");
    await markShellCall(plugin, "ses_git_error", "call_error");
    await expect(completeShellCall(plugin, "ses_git_error", "call_error")).resolves.toBeUndefined();
    expect(commitCalls(calls)).toHaveLength(0);
  });

  it("strips embedded credentials from the repo URL before posting", async () => {
    installGitMock(
      (marker) => [{ sha: SECOND_SHA, action: () => `${marker}: commit` }],
      "https://user:secret@example.com/team/repo.git?access_token=query-secret#fragment-secret",
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_creds");
    await markShellCall(plugin, "ses_creds", "call_creds");
    await completeShellCall(plugin, "ses_creds", "call_creds");

    expect(commitCalls(calls)[0]?.body?.repo).toBe("https://example.com/team/repo.git");
    const serialized = JSON.stringify(commitCalls(calls)[0]?.body);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("user:");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("fragment-secret");
  });

  it("strips SCP-style token userinfo from the repo URL before posting", async () => {
    installGitMock(
      (marker) => [{ sha: SECOND_SHA, action: () => `${marker}: commit` }],
      "deploy-token@github.com:team/repo.git",
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_scp_creds");
    await markShellCall(plugin, "ses_scp_creds", "call_scp_creds");
    await completeShellCall(plugin, "ses_scp_creds", "call_scp_creds");

    expect(commitCalls(calls)[0]?.body?.repo).toBe("github.com:team/repo.git");
    expect(JSON.stringify(commitCalls(calls)[0]?.body)).not.toContain("deploy-token@");
  });

  it("strips SCP-style git userinfo from the repo URL before posting", async () => {
    installGitMock(
      (marker) => [{ sha: SECOND_SHA, action: () => `${marker}: commit` }],
      "git@example.com:team/repo.git",
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_scp_git_user");
    await markShellCall(plugin, "ses_scp_git_user", "call_scp_git_user");
    await completeShellCall(plugin, "ses_scp_git_user", "call_scp_git_user");

    expect(commitCalls(calls)[0]?.body?.repo).toBe("example.com:team/repo.git");
    expect(JSON.stringify(commitCalls(calls)[0]?.body)).not.toContain("git@");
  });

  it("retries an unposted commit on the next completed shell tool", async () => {
    installGitMock((marker, attempt) => attempt === 1
      ? [{ sha: SECOND_SHA, action: () => `${marker}: first` }]
      : []);
    const { plugin, calls } = await loadPlugin((attempt) => attempt === 1 ? 500 : 200);
    await startSession(plugin, calls, "ses_retry");

    await markShellCall(plugin, "ses_retry", "call_retry_1");
    await completeShellCall(plugin, "ses_retry", "call_retry_1");
    expect(commitCalls(calls)).toHaveLength(1);

    await markShellCall(plugin, "ses_retry", "call_retry_2");
    await completeShellCall(plugin, "ses_retry", "call_retry_2");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, SECOND_SHA]);
  });

  it("links only the failed remainder when a multi-commit POST retries", async () => {
    installGitMock((marker, attempt) => attempt === 1
      ? [
          { sha: THIRD_SHA, action: () => `${marker}: third` },
          { sha: SECOND_SHA, action: () => `${marker}: second` },
        ]
      : []);
    const { plugin, calls } = await loadPlugin((attempt) => attempt === 2 ? 500 : 200);
    await startSession(plugin, calls, "ses_partial_retry");

    await markShellCall(plugin, "ses_partial_retry", "call_1");
    await completeShellCall(plugin, "ses_partial_retry", "call_1");
    const [remainder] = pendingCommitFiles();
    expect(remainder).toEqual(expect.any(String));
    if (!remainder) throw new Error("expected failed commit entry");
    expect(readFileSync(remainder, "utf-8")).toContain(THIRD_SHA);
    await markShellCall(plugin, "ses_partial_retry", "call_2");
    await completeShellCall(plugin, "ses_partial_retry", "call_2");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([
      SECOND_SHA,
      THIRD_SHA,
      THIRD_SHA,
    ]);
  });

  it("flushes later pending commits after the first pending commit fails", async () => {
    installGitMock((marker) => [
      { sha: THIRD_SHA, action: () => `${marker}: third` },
      { sha: SECOND_SHA, action: () => `${marker}: second` },
    ]);
    const { plugin, calls } = await loadPlugin((attempt) => attempt === 1 ? 500 : 200);
    await startSession(plugin, calls, "ses_continue_outbox_flush");
    await markShellCall(plugin, "ses_continue_outbox_flush", "call_continue_outbox_flush");
    await completeShellCall(plugin, "ses_continue_outbox_flush", "call_continue_outbox_flush");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, THIRD_SHA]);
    const pending = pendingCommitFiles().map((path) => readFileSync(path, "utf-8")).join("\n");
    expect(pending).toContain(SECOND_SHA);
    expect(pending).not.toContain(THIRD_SHA);
  });

  it("durably queues a completed overlapping tool before session deletion and reload", async () => {
    let firstMarker = "";
    let secondMarker = "";
    installGitMock((marker) => {
      if (marker === firstMarker) return [{ sha: SECOND_SHA, action: () => `${marker}: first` }];
      if (marker === secondMarker) return [{ sha: THIRD_SHA, action: () => `${marker}: second` }];
      return [];
    });
    const { plugin, calls } = await loadPlugin((attempt) => attempt === 1 ? 500 : 200);
    await startSession(plugin, calls, "ses_overlap_reload");
    firstMarker = await markShellCall(plugin, "ses_overlap_reload", "call_overlap_first");
    secondMarker = await markShellCall(plugin, "ses_overlap_reload", "call_overlap_second");
    await completeShellCall(plugin, "ses_overlap_reload", "call_overlap_first");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA]);
    expect(pendingCommitFiles().map((path) => readFileSync(path, "utf-8")).join("\n")).toContain(SECOND_SHA);

    await emitEvent(plugin, sessionDeletedEvent("ses_overlap_reload"));
    await plugin.dispose?.();
    activePlugin = null;
    const reloaded = await AgentmemoryCapturePlugin(FAKE_CTX);
    activePlugin = reloaded;
    await emitEvent(reloaded, sessionCreatedEvent("ses_overlap_reloaded"));

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, SECOND_SHA]);
  });

  it("retries an unposted commit after plugin reload", async () => {
    installGitMock((marker, attempt) => attempt === 1
      ? [{ sha: SECOND_SHA, action: () => `${marker}: commit` }]
      : []);
    const { plugin, calls } = await loadPlugin((attempt) => attempt === 1 ? 500 : 200);
    await startSession(plugin, calls, "ses_reload_before");
    await markShellCall(plugin, "ses_reload_before", "call_reload_before");
    await completeShellCall(plugin, "ses_reload_before", "call_reload_before");
    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA]);

    await plugin.dispose?.();
    activePlugin = null;
    const reloaded = await AgentmemoryCapturePlugin(FAKE_CTX);
    activePlugin = reloaded;
    await emitEvent(reloaded, sessionCreatedEvent("ses_reload_after"));

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, SECOND_SHA]);
  });

  it("does not flush a pending commit to a changed destination", async () => {
    installGitMock((marker, attempt) => attempt === 1
      ? [{ sha: SECOND_SHA, action: () => `${marker}: commit` }]
      : []);
    const calls = installFetchMock((attempt) => attempt === 1 ? 500 : 200);
    vi.stubEnv("AGENTMEMORY_URL", "https://destination-a.invalid");
    vi.stubEnv("AGENTMEMORY_SECRET", "credential-a");
    const firstModule = await loadIsolatedPluginModule();
    const firstPlugin = await firstModule.AgentmemoryCapturePlugin(FAKE_CTX);
    activePlugin = firstPlugin;
    await startSession(firstPlugin, calls, "ses_destination_a");
    await markShellCall(firstPlugin, "ses_destination_a", "call_destination_a");
    await completeShellCall(firstPlugin, "ses_destination_a", "call_destination_a");
    const [entryPath] = pendingCommitFiles();
    if (!entryPath) throw new Error("expected a pending commit entry");
    const entry: unknown = JSON.parse(readFileSync(entryPath, "utf-8"));
    if (!isRecord(entry)) throw new Error("expected a versioned pending commit entry");
    expect(entry["version"]).toBe(1);
    expect(typeof entry["destinationFingerprint"]).toBe("string");
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("destination-a.invalid");
    expect(serialized).not.toContain("credential-a");
    await firstPlugin.dispose?.();
    activePlugin = null;

    vi.stubEnv("AGENTMEMORY_URL", "https://destination-b.invalid");
    vi.stubEnv("AGENTMEMORY_SECRET", "credential-b");
    const secondModule = await loadIsolatedPluginModule();
    const secondPlugin = await secondModule.AgentmemoryCapturePlugin(FAKE_CTX);
    activePlugin = secondPlugin;
    await startSession(secondPlugin, calls, "ses_destination_b", false, false);

    expect(commitCalls(calls).map((call) => call.url)).toEqual([
      "https://destination-a.invalid/agentmemory/session/commit",
    ]);
    expect(pendingCommitFiles()).toHaveLength(1);
  });

  it("does not send legacy unbound pending commits", async () => {
    const outbox = join(commitOutboxDir, "opencode-pending-commits");
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    writeFileSync(join(outbox, "legacy.json"), JSON.stringify({
      sessionId: "ses_legacy",
      metadata: {
        sha: SECOND_SHA,
        message: MESSAGE,
        author: "Agent Tester",
        authoredAt: "2026-07-16T10:00:00+00:00",
        files: ["src/one.ts"],
      },
    }), { encoding: "utf-8", mode: 0o600 });
    const calls = installFetchMock();
    vi.stubEnv("AGENTMEMORY_URL", "https://destination-b.invalid");
    vi.stubEnv("AGENTMEMORY_SECRET", "credential-b");
    const module = await loadIsolatedPluginModule();
    const plugin = await module.AgentmemoryCapturePlugin(FAKE_CTX);
    activePlugin = plugin;
    await startSession(plugin, calls, "ses_legacy_flush");

    expect(commitCalls(calls)).toEqual([]);
    expect(pendingCommitFiles()).toHaveLength(1);
  });

  it("re-sanitizes queued repository URLs immediately before retry posting", async () => {
    installGitMock((marker, attempt) => attempt === 1
      ? [{ sha: SECOND_SHA, action: () => `${marker}: commit` }]
      : []);
    const { plugin, calls } = await loadPlugin((attempt) => attempt === 1 ? 500 : 200);
    await startSession(plugin, calls, "ses_retry_sanitize");
    await markShellCall(plugin, "ses_retry_sanitize", "call_retry_sanitize_1");
    await completeShellCall(plugin, "ses_retry_sanitize", "call_retry_sanitize_1");
    const [entryPath] = pendingCommitFiles();
    if (!entryPath) throw new Error("expected a pending commit entry");
    const entry: unknown = JSON.parse(readFileSync(entryPath, "utf-8"));
    if (!isRecord(entry) || !isRecord(entry["metadata"])) {
      throw new Error("expected a pending commit entry with metadata");
    }
    writeFileSync(entryPath, JSON.stringify({
      ...entry,
      metadata: {
        ...entry["metadata"],
        repo: "https://user:outbox-secret@example.com/team/repo.git?access_token=outbox-query#outbox-fragment",
      },
    }), { encoding: "utf-8", mode: 0o600 });

    await markShellCall(plugin, "ses_retry_sanitize", "call_retry_sanitize_2");
    await completeShellCall(plugin, "ses_retry_sanitize", "call_retry_sanitize_2");

    const retry = commitCalls(calls)[1];
    expect(retry?.body?.repo).toBe("https://example.com/team/repo.git");
    const serialized = JSON.stringify(retry?.body);
    expect(serialized).not.toContain("outbox-secret");
    expect(serialized).not.toContain("outbox-query");
    expect(serialized).not.toContain("outbox-fragment");
  });

  it("stores each failed commit as a private per-entry file", async () => {
    installGitMock((marker) => [{ sha: SECOND_SHA, action: () => `${marker}: commit` }]);
    const { plugin, calls } = await loadPlugin(() => 500);
    await startSession(plugin, calls, "ses_private_outbox");
    await markShellCall(plugin, "ses_private_outbox", "call_private_outbox");
    await completeShellCall(plugin, "ses_private_outbox", "call_private_outbox");

    const [entry] = pendingCommitFiles();
    expect(entry).toEqual(expect.any(String));
    if (!entry) throw new Error("expected a pending commit entry");
    expect(statSync(entry).mode & 0o777).toBe(0o600);
  });

  it("retains an unposted commit after its session is deleted", async () => {
    installGitMock((marker, attempt) => attempt === 1
      ? [{ sha: SECOND_SHA, action: () => `${marker}: commit` }]
      : []);
    const { plugin, calls } = await loadPlugin((attempt) => attempt === 1 ? 500 : 200);
    await startSession(plugin, calls, "ses_deleted_before");
    await markShellCall(plugin, "ses_deleted_before", "call_deleted_before");
    await completeShellCall(plugin, "ses_deleted_before", "call_deleted_before");
    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA]);

    await emitEvent(plugin, sessionDeletedEvent("ses_deleted_before"));
    await emitEvent(plugin, sessionCreatedEvent("ses_deleted_after"));

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, SECOND_SHA]);
    expect(commitCalls(calls).map((call) => call.body?.sessionId)).toEqual([
      "ses_deleted_before",
      "ses_deleted_before",
    ]);
  });

  it("retains a failed commit from an independent plugin writer", async () => {
    let markerA = "";
    let markerB = "";
    let markerC = "";
    let releaseRetry: (() => void) | undefined;
    let markRetryStarted: (() => void) | undefined;
    const retryRelease = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    installGitMock((marker) => {
      if (marker === markerA) return [{ sha: SECOND_SHA, action: () => `${marker}: first` }];
      if (marker === markerB) return [{ sha: THIRD_SHA, action: () => `${marker}: second` }];
      if (marker === markerC) return [{ sha: FOURTH_SHA, action: () => `${marker}: third` }];
      return [];
    });
    const { plugin, calls } = await loadPlugin(undefined, (attempt) => {
      if (attempt === 1) return new Response("commit failed", { status: 500 });
      if (attempt === 2) {
        markRetryStarted?.();
        return retryRelease.then(() => new Response("ok", { status: 200 }));
      }
      if (attempt === 4) return new Response("commit failed", { status: 500 });
      return new Response("ok", { status: 200 });
    });
    const isolatedModule = await loadIsolatedPluginModule();
    const isolatedPlugin = await isolatedModule.AgentmemoryCapturePlugin(FAKE_CTX);
    await startSession(plugin, calls, "ses_concurrent_a");
    await startSession(plugin, calls, "ses_concurrent_b", false);
    await startSession(isolatedPlugin, calls, "ses_concurrent_c", false);

    markerA = await markShellCall(plugin, "ses_concurrent_a", "call_concurrent_a");
    await completeShellCall(plugin, "ses_concurrent_a", "call_concurrent_a");
    markerB = await markShellCall(plugin, "ses_concurrent_b", "call_concurrent_b");
    markerC = await markShellCall(isolatedPlugin, "ses_concurrent_c", "call_concurrent_c");
    const secondCompletion = completeShellCall(plugin, "ses_concurrent_b", "call_concurrent_b");
    await retryStarted;
    await completeShellCall(isolatedPlugin, "ses_concurrent_c", "call_concurrent_c");

    if (!releaseRetry) throw new Error("retry release was not initialized");
    releaseRetry();
    await secondCompletion;
    await startSession(plugin, calls, "ses_concurrent_final", false, false);
    await isolatedPlugin.dispose?.();

    expect(commitCalls(calls).filter((call) => call.body?.sha === FOURTH_SHA)).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ sessionId: "ses_concurrent_c" }) }),
      expect.objectContaining({ body: expect.objectContaining({ sessionId: "ses_concurrent_c" }) }),
    ]);
  });
});
