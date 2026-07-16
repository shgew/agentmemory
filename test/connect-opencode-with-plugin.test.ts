import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const adapter = readFileSync(
  "src/cli/connect/opencode.ts",
  "utf-8",
);

const types = readFileSync(
  "src/cli/connect/types.ts",
  "utf-8",
);

describe("OpenCode connect adapter: --with-plugin flag", () => {
  it("declares withPlugin in ConnectOptions", () => {
    expect(types).toMatch(/withPlugin\??\s*:\s*boolean/);
  });

  it("branches on opts.withPlugin during install", () => {
    expect(adapter).toMatch(/opts\.withPlugin/);
  });

  it("resolves the plugin source from @agentmemory/agentmemory", () => {
    expect(adapter).toMatch(/agentmemory-capture\.ts/);
    expect(adapter).toMatch(/findPluginRoot\(\)/);
    expect(adapter).toMatch(/join\(pluginRoot,\s*["']opencode["']/);
  });

  it("targets ~/.config/opencode/plugins/ for the plugin file", () => {
    expect(adapter).toMatch(/["']plugins["']/);
  });

  it("relies on OpenCode plugin-directory discovery", () => {
    expect(adapter).not.toMatch(/mergePluginArray/);
    expect(adapter).not.toMatch(/config\[["']plugin["']\]\s*=/);
  });

  it("copies the agentmemory skills tree from plugin/skills/ to ~/.config/opencode/skills/", () => {
    expect(adapter).toMatch(/["']skills["']/);
    expect(adapter).toMatch(/skillsDir|SKILL_SOURCE|copySkillTree|join\([^)]*?["']skills["']/);
    expect(adapter).toMatch(/readdirSync|cpSync|recursive/);
  });

  it("does NOT ship the deleted /recall, /remember, /health markdown commands", () => {
    expect(adapter).not.toMatch(/SLASH_COMMANDS/);
    expect(adapter).not.toMatch(/function\s+commandsDir/);
    expect(adapter).not.toMatch(/mkdirSync\([^)]*?["']commands["']/);
    expect(adapter).not.toMatch(/copyFileSync\([^)]*?,\s*join\([^)]*?["']commands["']/);
  });

  it("removes deprecated agentmemory legacy command files on upgrade", () => {
    expect(adapter).toMatch(/LEGACY_COMMAND_FILES/);
    expect(adapter).toMatch(/cleanupLegacyCommands/);
    expect(adapter).toMatch(/recall\.md/);
    expect(adapter).toMatch(/remember\.md/);
    expect(adapter).toMatch(/health\.md/);
    expect(adapter).toMatch(/backupFile[^;]*opencode-legacy-command/);
    expect(adapter).toMatch(/LEGACY_COMMAND_HASHES/);
    expect(adapter).toMatch(/createHash\(["']sha256["']\)/);
    expect(adapter).toMatch(/rmSync/);
  });

  it("respects opts.dryRun for the plugin install path", () => {
    const installIdx = adapter.indexOf("async install");
    const body = adapter.slice(installIdx);
    expect(body).toMatch(/opts\.dryRun/);
  });
});
