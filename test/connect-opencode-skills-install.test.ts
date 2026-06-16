import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectAdapter } from "../src/cli/connect/types.js";

describe("agentmemory connect — opencode adapter --with-plugin (skills tree install)", () => {
  let customDir: string;
  let originalOpencodeConfigDir: string | undefined;

  beforeEach(() => {
    customDir = mkdtempSync(join(tmpdir(), "am-opencode-skills-"));
    originalOpencodeConfigDir = process.env["OPENCODE_CONFIG_DIR"];
    process.env["OPENCODE_CONFIG_DIR"] = customDir;
  });

  afterEach(() => {
    if (originalOpencodeConfigDir !== undefined) {
      process.env["OPENCODE_CONFIG_DIR"] = originalOpencodeConfigDir;
    } else {
      delete process.env["OPENCODE_CONFIG_DIR"];
    }
    rmSync(customDir, { recursive: true, force: true });
  });

  async function loadAdapter(): Promise<ConnectAdapter> {
    const mod = await import("../src/cli/connect/opencode.js?t=" + Date.now());
    return (mod as { adapter: ConnectAdapter }).adapter;
  }

  it("copies all 9 invocable skills (recall, remember, health, recap, handoff, forget, commit-context, commit-history, session-history) to <OPENCODE_CONFIG_DIR>/skills/", async () => {
    const adapter = await loadAdapter();
    const result = await adapter.install({
      dryRun: false,
      force: false,
      withPlugin: true,
    });
    expect(result.kind).toBe("installed");

    const invocable = [
      "recall",
      "remember",
      "health",
      "recap",
      "handoff",
      "forget",
      "commit-context",
      "commit-history",
      "session-history",
    ];
    for (const name of invocable) {
      expect(existsSync(join(customDir, "skills", name, "SKILL.md"))).toBe(true);
    }
  });

  it("copies all 7 reference skills to <OPENCODE_CONFIG_DIR>/skills/", async () => {
    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false, withPlugin: true });

    const reference = [
      "agentmemory-mcp-tools",
      "agentmemory-rest-api",
      "agentmemory-config",
      "agentmemory-agents",
      "agentmemory-hooks",
      "agentmemory-architecture",
      "write-agentmemory-skill",
    ];
    for (const name of reference) {
      expect(existsSync(join(customDir, "skills", name, "SKILL.md"))).toBe(true);
    }
  });

  it("preserves sibling files in skill directories (EXAMPLES.md, REFERENCE.md)", async () => {
    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false, withPlugin: true });

    expect(existsSync(join(customDir, "skills", "recall", "EXAMPLES.md"))).toBe(true);
    expect(existsSync(join(customDir, "skills", "remember", "EXAMPLES.md"))).toBe(true);
    expect(existsSync(join(customDir, "skills", "forget", "EXAMPLES.md"))).toBe(true);
    expect(existsSync(join(customDir, "skills", "agentmemory-mcp-tools", "REFERENCE.md"))).toBe(true);
    expect(existsSync(join(customDir, "skills", "agentmemory-rest-api", "REFERENCE.md"))).toBe(true);
  });

  it("copies the _shared/ directory referenced by skill bodies", async () => {
    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false, withPlugin: true });

    expect(existsSync(join(customDir, "skills", "_shared", "TROUBLESHOOTING.md"))).toBe(true);
  });

  it("does NOT create a commands/ directory", async () => {
    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false, withPlugin: true });

    expect(existsSync(join(customDir, "commands"))).toBe(false);
    expect(existsSync(join(customDir, "commands", "recall.md"))).toBe(false);
    expect(existsSync(join(customDir, "commands", "remember.md"))).toBe(false);
    expect(existsSync(join(customDir, "commands", "health.md"))).toBe(false);
  });

  it("still copies the auto-capture plugin TS and wires opencode.json (regression guard)", async () => {
    const adapter = await loadAdapter();
    const result = await adapter.install({
      dryRun: false,
      force: false,
      withPlugin: true,
    });
    expect(result.kind).toBe("installed");

    expect(existsSync(join(customDir, "plugins", "agentmemory-capture.ts"))).toBe(true);

    const config = JSON.parse(readFileSync(join(customDir, "opencode.json"), "utf-8"));
    expect(config.mcp.agentmemory.command).toContain("@agentmemory/mcp");
    expect(config.plugin).toContain("./plugins/agentmemory-capture.ts");
  });

  it("dry-run announces skills copy but does NOT touch the filesystem", async () => {
    const adapter = await loadAdapter();
    const result = await adapter.install({
      dryRun: true,
      force: false,
      withPlugin: true,
    });
    expect(result.kind).toBe("installed");

    expect(existsSync(join(customDir, "skills"))).toBe(false);
    expect(existsSync(join(customDir, "plugins"))).toBe(false);
    expect(existsSync(join(customDir, "opencode.json"))).toBe(false);
  });
});
