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
    expect(adapter).toMatch(/@agentmemory\/agentmemory|plugin\/opencode/);
  });

  it("targets ~/.config/opencode/plugins/ for the plugin file", () => {
    expect(adapter).toMatch(/["']plugins["']/);
  });

  it("merges the plugin path into the opencode.json 'plugin' array", () => {
    expect(adapter).toMatch(/["']plugin["']\s*\]?[\s\S]{0,200}?agentmemory-capture/);
  });

  it("copies the recall and remember slash commands to ~/.config/opencode/commands/", () => {
    expect(adapter).toMatch(/recall\.md/);
    expect(adapter).toMatch(/remember\.md/);
    expect(adapter).toMatch(/["']commands["']/);
  });

  it("respects opts.dryRun for the plugin install path", () => {
    const installIdx = adapter.indexOf("async install");
    const body = adapter.slice(installIdx);
    expect(body).toMatch(/opts\.dryRun/);
  });
});
