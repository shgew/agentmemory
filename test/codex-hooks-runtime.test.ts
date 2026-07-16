import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..");
const pluginRoot = join(repoRoot, "plugin");

type ObservedRequest = {
  path: string;
  body: Record<string, unknown>;
};

async function runHook(
  script: string,
  payload: Record<string, unknown>,
): Promise<ObservedRequest[]> {
  const requests: ObservedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });

  await new Promise<void>((resolveServer) => {
    server.listen(0, "127.0.0.1", resolveServer);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("test server did not bind to a TCP port");
  }

  try {
    const child = spawn(process.execPath, [join(pluginRoot, script)], {
      env: {
        ...process.env,
        AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
        AGENTMEMORY_SECRET: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(JSON.stringify(payload));

    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`hook ${script} timed out`));
      }, 5000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolveExit(code);
      });
    });

    expect(exitCode, stderr).toBe(0);
    return requests;
  } finally {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }
}

describe("Codex lifecycle hooks", () => {
  it("marks resumed sessions explicitly", async () => {
    const requests = await runHook("scripts/session-start.mjs", {
      session_id: "codex-session",
      cwd: repoRoot,
      source: "resume",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/agentmemory/session/start");
    expect(requests[0]?.body).toMatchObject({
      sessionId: "codex-session",
      resumed: true,
    });
  });

  it("records the completed assistant turn without ending or summarizing the session", async () => {
    const requests = await runHook("scripts/stop.mjs", {
      session_id: "codex-session",
      cwd: repoRoot,
      last_assistant_message: "Implemented the lifecycle fix.",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/agentmemory/observe");
    expect(requests[0]?.body).toMatchObject({
      hookType: "assistant_message",
      sessionId: "codex-session",
      data: { message: "Implemented the lifecycle fix." },
    });
    expect(requests.map((request) => request.path)).not.toContain(
      "/agentmemory/summarize",
    );
    expect(requests.map((request) => request.path)).not.toContain(
      "/agentmemory/session/end",
    );
  });

  it("records Codex subagent lifecycle payloads", async () => {
    const startRequests = await runHook("scripts/subagent-start.mjs", {
      session_id: "codex-session",
      cwd: repoRoot,
      agent_id: "subagent-1",
      agent_type: "worker",
    });
    const stopRequests = await runHook("scripts/subagent-stop.mjs", {
      session_id: "codex-session",
      cwd: repoRoot,
      agent_id: "subagent-1",
      agent_type: "worker",
      last_assistant_message: "Subtask complete.",
    });

    expect(startRequests[0]?.body).toMatchObject({
      hookType: "subagent_start",
      sessionId: "codex-session",
      data: {
        agent_id: "subagent-1",
        agent_type: "worker",
      },
    });
    expect(stopRequests[0]?.body).toMatchObject({
      hookType: "subagent_stop",
      sessionId: "codex-session",
      data: {
        agent_id: "subagent-1",
        agent_type: "worker",
        last_message: "Subtask complete.",
      },
    });
  });
});
