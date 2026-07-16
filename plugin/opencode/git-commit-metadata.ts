/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { env } from "node:process";

export type GitCommitMetadata = {
  readonly sha: string;
  readonly branch?: string;
  readonly repo?: string;
  readonly message: string;
  readonly author: string;
  readonly authoredAt: string;
  readonly files: readonly string[];
};

const GIT_TIMEOUT_MS = 500;
const DEBUG = env.OPENCODE_AGENTMEMORY_DEBUG === "1";

export function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  }).toString().trim();
}

export function tryGit(cwd: string, args: readonly string[]): string | null {
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

export function collectGitCommitMetadata(cwd: string, sha: string): GitCommitMetadata | null {
  const branchOutput = tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchOutput === null) return null;
  const repo = tryGit(cwd, ["remote", "get-url", "origin"]);
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
