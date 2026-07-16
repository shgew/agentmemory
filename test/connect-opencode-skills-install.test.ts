import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectAdapter } from "../src/cli/connect/types.js";

const LEGACY_RECALL_COMMAND = [
  "Search past session observations and lessons for relevant context. Wrap the `memory_smart_search` and `memory_lesson_recall` MCP tools.",
  "",
  "## Usage",
  "",
  "```",
  "/recall [query]",
  "```",
  "",
  "## Instructions",
  "",
  "1. Call `memory_smart_search` with the query and `limit: 10` (hybrid BM25 + vector + graph search).",
  "2. Call `memory_lesson_recall` with the same query and `limit: 5` (lesson search).",
  "3. Combine results and present to the user:",
  "   - Group by session",
  "   - Show type, title, and narrative for each observation",
  "   - Highlight high-importance (>= 7) observations",
  "   - Show lessons separately with confidence scores",
  "4. If no results, suggest 2-3 alternative search terms.",
  "5. **Never hallucinate results.** Only present what the MCP tools actually return.",
  "",
].join("\n");

describe("agentmemory connect: opencode adapter --with-plugin skills tree install", () => {
  let customDir: string;
  let originalOpencodeConfigDir: string | undefined;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    customDir = mkdtempSync(join(tmpdir(), "am-opencode-skills-"));
    originalOpencodeConfigDir = process.env["OPENCODE_CONFIG_DIR"];
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    process.env["OPENCODE_CONFIG_DIR"] = customDir;
    process.env["HOME"] = customDir;
    process.env["USERPROFILE"] = customDir;
  });

  afterEach(() => {
    if (originalOpencodeConfigDir !== undefined) {
      process.env["OPENCODE_CONFIG_DIR"] = originalOpencodeConfigDir;
    } else {
      delete process.env["OPENCODE_CONFIG_DIR"];
    }
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (originalUserprofile !== undefined) {
      process.env["USERPROFILE"] = originalUserprofile;
    } else {
      delete process.env["USERPROFILE"];
    }
    vi.useRealTimers();
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

  it("copies the auto-capture plugin and relies on plugin-directory discovery", async () => {
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
    expect(config.plugin).toBeUndefined();
  });

  it("creates collision-proof backups when the clock does not advance", async () => {
    const source = join(customDir, "source.json");
    writeFileSync(source, "original");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));

    const { backupFile } = await import("../src/cli/connect/util.js");
    const first = backupFile(source, "opencode");
    const second = backupFile(source, "opencode");

    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf-8")).toBe("original");
    expect(readFileSync(second, "utf-8")).toBe("original");
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

describe("agentmemory connect: opencode adapter --with-plugin legacy command cleanup", () => {
  let customDir: string;
  let originalOpencodeConfigDir: string | undefined;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    customDir = mkdtempSync(join(tmpdir(), "am-opencode-legacy-"));
    originalOpencodeConfigDir = process.env["OPENCODE_CONFIG_DIR"];
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    process.env["OPENCODE_CONFIG_DIR"] = customDir;
    process.env["HOME"] = customDir;
    process.env["USERPROFILE"] = customDir;
  });

  afterEach(() => {
    if (originalOpencodeConfigDir !== undefined) {
      process.env["OPENCODE_CONFIG_DIR"] = originalOpencodeConfigDir;
    } else {
      delete process.env["OPENCODE_CONFIG_DIR"];
    }
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (originalUserprofile !== undefined) {
      process.env["USERPROFILE"] = originalUserprofile;
    } else {
      delete process.env["USERPROFILE"];
    }
    rmSync(customDir, { recursive: true, force: true });
  });

  async function loadAdapter(): Promise<ConnectAdapter> {
    const mod = await import("../src/cli/connect/opencode.js?t=" + Date.now());
    return (mod as { adapter: ConnectAdapter }).adapter;
  }

  it("removes generated legacy command files on upgrade", async () => {
    mkdirSync(join(customDir, "commands"), { recursive: true });
    writeFileSync(join(customDir, "commands", "recall.md"), LEGACY_RECALL_COMMAND);

    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false, withPlugin: true });

    expect(existsSync(join(customDir, "commands", "recall.md"))).toBe(false);
  });

  it("preserves user-owned commands that reuse a generated filename", async () => {
    mkdirSync(join(customDir, "commands"), { recursive: true });
    writeFileSync(join(customDir, "commands", "recall.md"), "custom recall command");

    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false, withPlugin: true });

    expect(readFileSync(join(customDir, "commands", "recall.md"), "utf-8")).toBe(
      "custom recall command",
    );
    expect(existsSync(join(customDir, "commands"))).toBe(true);
  });

  it("preserves user-owned command files alongside generated cleanup", async () => {
    mkdirSync(join(customDir, "commands"), { recursive: true });
    writeFileSync(join(customDir, "commands", "recall.md"), LEGACY_RECALL_COMMAND);
    writeFileSync(join(customDir, "commands", "my-custom.md"), "user command");

    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false, withPlugin: true });

    expect(existsSync(join(customDir, "commands", "recall.md"))).toBe(false);
    expect(readFileSync(join(customDir, "commands", "my-custom.md"), "utf-8")).toBe(
      "user command",
    );
  });

  it("removes the commands directory when it only contained generated files", async () => {
    mkdirSync(join(customDir, "commands"), { recursive: true });
    writeFileSync(join(customDir, "commands", "recall.md"), LEGACY_RECALL_COMMAND);

    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false, withPlugin: true });

    expect(existsSync(join(customDir, "commands"))).toBe(false);
  });

  it("dry-run announces legacy cleanup but does NOT touch the filesystem", async () => {
    mkdirSync(join(customDir, "commands"), { recursive: true });
    writeFileSync(join(customDir, "commands", "recall.md"), LEGACY_RECALL_COMMAND);

    const adapter = await loadAdapter();
    await adapter.install({ dryRun: true, force: false, withPlugin: true });

    expect(existsSync(join(customDir, "commands", "recall.md"))).toBe(true);
  });

  it("is a no-op when no legacy commands directory exists", async () => {
    const adapter = await loadAdapter();
    const result = await adapter.install({ dryRun: false, force: false, withPlugin: true });
    expect(result.kind).toBe("installed");
    expect(existsSync(join(customDir, "commands"))).toBe(false);
    expect(existsSync(join(customDir, "skills", "recall", "SKILL.md"))).toBe(true);
  });
});
