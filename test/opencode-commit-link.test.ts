import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentmemoryCapturePlugin } from "../plugin/opencode/agentmemory-capture";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

type PluginInstance = Awaited<ReturnType<typeof AgentmemoryCapturePlugin>>;
type PostCall = { url: string; body: Record<string, unknown> | null };

const FAKE_CTX = {
  worktree: "/tmp/test-worktree",
  project: { id: "/tmp/test-worktree" },
  client: undefined,
  directory: "/tmp/test-worktree",
  $: undefined,
} as any;

const OLD_SHA = "1111111111111111111111111111111111111111";
const NEW_SHA = "2222222222222222222222222222222222222222";
const MESSAGE = 'fix: preserve $(touch /tmp/not-executed); "quotes"';

let activePlugin: PluginInstance | null = null;

function installFetchMock(): PostCall[] {
  const calls: PostCall[] = [];
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
    return new Response(JSON.stringify({ context: "<test-context>" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
  return calls;
}

function installGitMock(heads: readonly (string | Error)[]): void {
  let headIndex = 0;
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    const command = (args ?? []).slice(2).join(" ");
    if (command === "rev-parse HEAD") {
      const value = heads[headIndex++];
      if (value instanceof Error) throw value;
      return Buffer.from(`${value}\n`);
    }
    if (command === "rev-parse --abbrev-ref HEAD") return Buffer.from("feature/commit-link\n");
    if (command === "remote get-url origin") return Buffer.from("git@example.com:team/repo.git\n");
    if (command.startsWith("show -s --format=")) {
      return Buffer.from(`${MESSAGE}\u0000Agent Tester\u00002026-07-16T10:00:00+00:00\n`);
    }
    if (command.startsWith("diff-tree --no-commit-id --name-only -r")) {
      return Buffer.from("src/one.ts\ntest/one.test.ts\n");
    }
    throw new Error(`unexpected git command: ${command}`);
  });
}

async function loadPlugin(): Promise<{ plugin: PluginInstance; calls: PostCall[] }> {
  const calls = installFetchMock();
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

  it("posts final HEAD metadata after a successful tool completion changes HEAD", async () => {
    installGitMock([OLD_SHA, NEW_SHA]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_commit");

    await plugin["tool.execute.after"]!(
      { tool: "Bash", sessionID: "ses_commit", callID: "call_commit", args: { command: "git commit -m ignored" } } as any,
      { output: "committed", title: "git commit", metadata: {} } as any,
    );

    const commitPost = commitCalls(calls);
    expect(commitPost).toHaveLength(1);
    expect(commitPost[0]?.body).toEqual({
      sha: NEW_SHA,
      sessionId: "ses_commit",
      branch: "feature/commit-link",
      repo: "git@example.com:team/repo.git",
      message: MESSAGE,
      author: "Agent Tester",
      authoredAt: "2026-07-16T10:00:00+00:00",
      files: ["src/one.ts", "test/one.test.ts"],
    });
    for (const [file, args, options] of vi.mocked(execFileSync).mock.calls) {
      expect(file).toBe("git");
      expect(args?.slice(0, 2)).toEqual(["-C", FAKE_CTX.directory]);
      expect(options).toMatchObject({ timeout: expect.any(Number) });
    }
  });

  it("does not post when HEAD is unchanged", async () => {
    installGitMock([OLD_SHA, OLD_SHA]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_unchanged");

    await plugin["tool.execute.after"]!(
      { tool: "Edit", sessionID: "ses_unchanged", callID: "call_edit", args: { filePath: "src/one.ts" } } as any,
      { output: "edited", title: "edit", metadata: {} } as any,
    );

    expect(commitCalls(calls)).toHaveLength(0);
  });

  it("does not re-read HEAD after a failed tool completion", async () => {
    installGitMock([OLD_SHA]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_failed");

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

    expect(commitCalls(calls)).toHaveLength(0);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
  });

  it("does not post or throw when the HEAD re-read fails", async () => {
    installGitMock([OLD_SHA, new Error("not a git repository")]);
    const { plugin, calls } = await loadPlugin();
    await startSession(plugin, calls, "ses_git_error");

    await expect(plugin["tool.execute.after"]!(
      { tool: "Bash", sessionID: "ses_git_error", callID: "call_error", args: { command: "git commit" } } as any,
      { output: "ignored", title: "git", metadata: {} } as any,
    )).resolves.toBeUndefined();

    expect(commitCalls(calls)).toHaveLength(0);
  });
});
