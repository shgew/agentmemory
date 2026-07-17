import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const hook = fileURLToPath(new URL("../src/hooks/post-commit.ts", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx");
const directories: string[] = [];

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function runHook(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsx, hook], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`post-commit exited with ${code}: ${Buffer.concat(stderr).toString("utf-8")}`));
    });
    child.stdin.end(JSON.stringify({ cwd }));
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("post-commit hook", () => {
  it.skipIf(process.platform === "win32")(
    "strips credentials, query parameters, and fragments from repository metadata before posting",
    async () => {
      const repository = tempDirectory("am-post-commit-repo-");
      const bin = tempDirectory("am-post-commit-bin-");
      const git = join(bin, "git");
      const received: string[] = [];
      writeFileSync(
        git,
        `#!/bin/sh
case "$1 $2 $3" in
  "rev-parse HEAD") printf '%s\\n' '1111111111111111111111111111111111111111' ;;
  "rev-parse --abbrev-ref") printf '%s\\n' 'main' ;;
  "config --get remote.origin.url") printf '%s\\n' 'https://access-token:secret@example.com/team/repo.git?token=query-token#fragment-token' ;;
  "log -1 --pretty=%B") printf '%s\\n' 'commit message' ;;
  "log -1 --pretty=%an <%ae>") printf '%s\\n' 'Test User <test@example.com>' ;;
  "log -1 --pretty=%aI") printf '%s\\n' '2026-07-17T12:00:00+00:00' ;;
  "diff-tree --no-commit-id --name-only") printf '%s\\n' 'src/file.ts' ;;
esac
`,
      );
      chmodSync(git, 0o755);

      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          received.push(Buffer.concat(chunks).toString("utf-8"));
          response.writeHead(200).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");

      try {
        await runHook(repository, {
          ...process.env,
          AGENTMEMORY_COMMIT_SHA: "1111111111111111111111111111111111111111",
          AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        });
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }

      const payload = JSON.parse(received[0] ?? "{}") as { repo?: string };
      expect(payload.repo).toBe("https://example.com/team/repo.git");
    },
  );
});
