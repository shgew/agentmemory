import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "../src/hooks/_project.js";

describe("resolveProject - hook project basename resolver", () => {
  const originalEnv = process.env.AGENTMEMORY_PROJECT_NAME;

  beforeEach(() => {
    delete process.env.AGENTMEMORY_PROJECT_NAME;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTMEMORY_PROJECT_NAME;
    } else {
      process.env.AGENTMEMORY_PROJECT_NAME = originalEnv;
    }
  });

  it("AGENTMEMORY_PROJECT_NAME env wins over everything", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "my-override";
    expect(resolveProject("/var/log")).toBe("my-override");
    expect(resolveProject(process.cwd())).toBe("my-override");
  });

  it("trims whitespace on env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "  spaced  ";
    expect(resolveProject("/var/log")).toBe("spaced");
  });

  it("ignores empty env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "   ";
    const repoBasename = "agentmemory";
    expect(resolveProject(process.cwd())).toBe(repoBasename);
  });

  it("returns git toplevel basename when cwd is inside a repo", () => {
    const top = resolveProject(process.cwd());
    expect(top).toBe("agentmemory");
  });

  it("returns git toplevel basename from a nested subdir", () => {
    const nested = join(process.cwd(), "src", "hooks");
    expect(resolveProject(nested)).toBe("agentmemory");
  });

  it("falls back to basename(cwd) when not in a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "amem-noproj-"));
    try {
      expect(resolveProject(dir)).toBe(dir.split("/").pop());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to process.cwd() when no cwd argument given", () => {
    expect(resolveProject()).toBe("agentmemory");
  });

  it("defaults to process.cwd() when cwd argument is empty", () => {
    expect(resolveProject("")).toBe("agentmemory");
    expect(resolveProject("   ")).toBe("agentmemory");
  });

  it("returns main repo basename from a linked worktree", () => {
    const parent = mkdtempSync(join(tmpdir(), "amem-worktree-"));
    const main = join(parent, "main-repo");
    const worktree = join(parent, "feature-checkout");
    try {
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

      expect(resolveProject(worktree)).toBe("main-repo");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5000,
  });
}
