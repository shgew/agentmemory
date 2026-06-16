import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";

export function resolveProject(cwd?: string): string {
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
  return execFileSync("git", ["rev-parse", arg], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 500,
  })
    .toString()
    .trim();
}
