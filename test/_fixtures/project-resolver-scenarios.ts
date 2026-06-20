import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type ProjectResolverScenarioSetup = {
  envProjectName?: string;
  hookCwdArgs: Array<string | undefined>;
  pluginCwd: string;
  expected: string;
  cleanup?: () => void;
};

export type ProjectResolverScenario = {
  name: string;
  setup: () => ProjectResolverScenarioSetup;
};

export const RESOLVER_SCENARIOS = [
  {
    name: "AGENTMEMORY_PROJECT_NAME env wins over everything",
    setup: () => ({
      envProjectName: "my-override",
      hookCwdArgs: ["/var/log", process.cwd()],
      pluginCwd: "/var/log",
      expected: "my-override",
    }),
  },
  {
    name: "trims whitespace on env override",
    setup: () => ({
      envProjectName: "  spaced  ",
      hookCwdArgs: ["/var/log"],
      pluginCwd: "/var/log",
      expected: "spaced",
    }),
  },
  {
    name: "ignores empty env override",
    setup: () => ({
      envProjectName: "   ",
      hookCwdArgs: [process.cwd()],
      pluginCwd: process.cwd(),
      expected: "agentmemory",
    }),
  },
  {
    name: "returns git toplevel basename when cwd is inside a repo",
    setup: () => ({
      hookCwdArgs: [process.cwd()],
      pluginCwd: process.cwd(),
      expected: "agentmemory",
    }),
  },
  {
    name: "returns git toplevel basename from a nested subdir",
    setup: () => {
      const nested = join(process.cwd(), "src", "hooks");
      return {
        hookCwdArgs: [nested],
        pluginCwd: nested,
        expected: "agentmemory",
      };
    },
  },
  {
    name: "falls back to basename(cwd) when not in a git repo",
    setup: () => {
      const dir = mkdtempSync(join(tmpdir(), "amem-noproj-"));
      return {
        hookCwdArgs: [dir],
        pluginCwd: dir,
        expected: basename(dir),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "defaults to process.cwd() when no cwd argument given",
    setup: () => ({
      hookCwdArgs: [undefined],
      pluginCwd: process.cwd(),
      expected: "agentmemory",
    }),
  },
  {
    name: "defaults to process.cwd() when cwd argument is empty",
    setup: () => ({
      hookCwdArgs: ["", "   "],
      pluginCwd: process.cwd(),
      expected: "agentmemory",
    }),
  },
  {
    name: "returns main repo basename from a linked worktree",
    setup: () => {
      const parent = mkdtempSync(join(tmpdir(), "amem-worktree-"));
      const main = join(parent, "main-repo");
      const worktree = join(parent, "feature-checkout");
      mkdirSync(main);
      git(main, "init");
      writeFileSync(join(main, "README.md"), "test\n");
      git(main, "add", "README.md");
      git(
        main,
        "-c",
        "user.name=Agentmemory",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "init",
      );
      git(main, "worktree", "add", worktree);

      return {
        hookCwdArgs: [worktree],
        pluginCwd: worktree,
        expected: "main-repo",
        cleanup: () => rmSync(parent, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "ctx.project.id is ignored",
    setup: () => ({
      hookCwdArgs: [process.cwd()],
      pluginCwd: process.cwd(),
      expected: "agentmemory",
    }),
  },
] satisfies ProjectResolverScenario[];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5000,
  });
}
