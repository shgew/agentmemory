import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentmemoryCapturePlugin } from "../plugin/opencode/agentmemory-capture";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

type PluginInstance = Awaited<ReturnType<typeof AgentmemoryCapturePlugin>>;
type PostCall = { url: string; body: Record<string, unknown> | null };
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

const FAKE_CTX = {
  worktree: "/tmp/test-worktree",
  project: { id: "/tmp/test-worktree" },
  client: undefined,
  directory: "/tmp/test-worktree",
  $: undefined,
} as any;

const SECOND_SHA = "2222222222222222222222222222222222222222";
const THIRD_SHA = "3333333333333333333333333333333333333333";
const FOURTH_SHA = "4444444444444444444444444444444444444444";
const MESSAGE = 'fix: preserve $(touch /tmp/not-executed); "quotes"';

let activePlugin: PluginInstance | null = null;

function installFetchMock(commitStatusFor?: (attempt: number) => number): PostCall[] {
  const calls: PostCall[] = [];
  let commitAttempt = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : null;
    calls.push({ url, body });
    if (url.endsWith("/agentmemory/session/commit")) {
      const status = commitStatusFor ? commitStatusFor(++commitAttempt) : 200;
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
      const sha = gitArgs[2]!;
      const tip = gitArgs[3]!;
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

async function loadPlugin(commitStatusFor?: (attempt: number) => number): Promise<{ plugin: PluginInstance; calls: PostCall[] }> {
  const calls = installFetchMock(commitStatusFor);
  const plugin = await AgentmemoryCapturePlugin(FAKE_CTX);
  activePlugin = plugin;
  return { plugin, calls };
}

async function startSession(plugin: PluginInstance, calls: PostCall[], sessionId: string): Promise<void> {
  await plugin.event!({
    event: { type: "session.created", properties: { info: { id: sessionId } } } as any,
  });
  expect(calls.some((call) => call.url.endsWith("/agentmemory/session/commit"))).toBe(false);
  calls.length = 0;
}

async function markShellCall(
  plugin: PluginInstance,
  sessionId: string,
  callId: string,
  cwd = FAKE_CTX.directory,
): Promise<string> {
  const output = { env: {} as Record<string, string> };
  await plugin["shell.env"]!({ cwd, sessionID: sessionId, callID: callId }, output);
  return output.env.GIT_REFLOG_ACTION!;
}

async function completeShellCall(plugin: PluginInstance, sessionId: string, callId: string): Promise<void> {
  await plugin["tool.execute.after"]!(
    { tool: "Bash", sessionID: sessionId, callID: callId, args: { command: "git commit" } } as any,
    { output: "completed", title: "bash", metadata: {} } as any,
  );
}

function commitCalls(calls: readonly PostCall[]): PostCall[] {
  return calls.filter((call) => call.url.endsWith("/agentmemory/session/commit"));
}

describe("OpenCode commit-link capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AGENTMEMORY_PROJECT_NAME", "agentmemory");
  });

  afterEach(async () => {
    if (activePlugin?.dispose) await activePlugin.dispose();
    activePlugin = null;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["undefined", undefined],
    ["empty object", {}],
  ])("returns hooks when plugin input is %s", async (_label, input) => {
    installFetchMock();
    const plugin = await AgentmemoryCapturePlugin(input as any);
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
        repo: "git@example.com:team/repo.git",
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

  it("waits for all overlapping shell tools before inspecting their reflogs", async () => {
    installGitMock((marker, attempt) => attempt === 1
      ? [{ sha: SECOND_SHA, action: () => `${marker}: first tool` }]
      : [{ sha: THIRD_SHA, action: () => `${marker}: second tool` }]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_overlap");

    await markShellCall(plugin, "ses_overlap", "call_1");
    await markShellCall(plugin, "ses_overlap", "call_2");
    await completeShellCall(plugin, "ses_overlap", "call_1");
    expect(commitCalls(calls)).toHaveLength(0);

    await completeShellCall(plugin, "ses_overlap", "call_2");
    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([SECOND_SHA, THIRD_SHA]);
  });

  it("merges overlapping shell commits by reflog order after both tools settle", async () => {
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
    expect(commitCalls(calls)).toHaveLength(0);

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
    expect(headReflogCalls).toHaveLength(1);
    expect(headReflogCalls[0]?.[1]?.slice(0, 2)).toEqual(["-C", "/tmp/repo"]);
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

    await plugin.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "ses_failed",
            callID: "call_failed",
            tool: "Bash",
            state: { status: "error", input: "git commit", error: "failed", time: {} },
          },
        },
      } as any,
    });

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
      "https://user:secret@example.com/team/repo.git",
    );
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_creds");
    await markShellCall(plugin, "ses_creds", "call_creds");
    await completeShellCall(plugin, "ses_creds", "call_creds");

    expect(commitCalls(calls)[0]?.body?.repo).toBe("https://example.com/team/repo.git");
    const serialized = JSON.stringify(commitCalls(calls)[0]?.body);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("user:");
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
    await markShellCall(plugin, "ses_partial_retry", "call_2");
    await completeShellCall(plugin, "ses_partial_retry", "call_2");

    expect(commitCalls(calls).map((call) => call.body?.sha)).toEqual([
      SECOND_SHA,
      THIRD_SHA,
      THIRD_SHA,
    ]);
  });
});
