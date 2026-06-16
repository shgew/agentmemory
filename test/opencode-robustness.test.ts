import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const plugin = readFileSync(
  "plugin/opencode/agentmemory-capture.ts",
  "utf-8",
);

describe("OpenCode plugin: HTTPS guard", () => {
  it("declares a loopback host allow-list", () => {
    expect(plugin).toMatch(/LOOPBACK_HOSTS/);
  });

  it("warns when SECRET is set on a non-loopback http URL", () => {
    expect(plugin).toMatch(/console\.warn\(/);
    expect(plugin).toMatch(/AGENTMEMORY_SECRET[\s\S]*?plaintext|plaintext[\s\S]*?AGENTMEMORY_SECRET/i);
  });
});

describe("OpenCode plugin: health probe at init", () => {
  it("fetches /agentmemory/health from plugin init when DEBUG=1", () => {
    const pluginExportIdx = plugin.indexOf("export const AgentmemoryCapturePlugin");
    const body = plugin.slice(pluginExportIdx);
    expect(body).toMatch(/if\s*\(\s*DEBUG\s*\)[\s\S]*?\/agentmemory\/health/);
  });
});

describe("OpenCode plugin: tool output sanitization", () => {
  it("declares a sanitizeOutput helper", () => {
    expect(plugin).toMatch(/function\s+sanitizeOutput\s*\(/);
  });

  it("strips data: URLs and base64 image prefixes", () => {
    const idx = plugin.indexOf("function sanitizeOutput");
    expect(idx).toBeGreaterThan(-1);
    const block = plugin.slice(idx, idx + 1200);
    expect(block).toMatch(/data:image\//);
    expect(block).toMatch(/iVBORw0KGgo|\/9j\//);
  });

  it("wraps tool_output through sanitizeOutput in post_tool_use", () => {
    const idx = plugin.indexOf('"post_tool_use"');
    expect(idx).toBeGreaterThan(-1);
    const block = plugin.slice(idx, idx + 800);
    expect(block).toMatch(/sanitizeOutput\(/);
  });
});

describe("OpenCode plugin: configurable timeouts", () => {
  it("reads OPENCODE_AGENTMEMORY_TIMEOUT_MS with a 5000 default", () => {
    expect(plugin).toMatch(/OPENCODE_AGENTMEMORY_TIMEOUT_MS[\s\S]*?5000/);
  });

  it("reads OPENCODE_AGENTMEMORY_HEAVY_TIMEOUT_MS with a 30_000 default", () => {
    expect(plugin).toMatch(/OPENCODE_AGENTMEMORY_HEAVY_TIMEOUT_MS[\s\S]*?30[_]?000/);
  });

  it("uses TIMEOUT_MS in the default post() timeout", () => {
    expect(plugin).toMatch(/timeoutMs\s*=\s*TIMEOUT_MS/);
  });

  it("uses HEAVY_TIMEOUT_MS for /crystals/auto and /consolidate-pipeline", () => {
    const idx = plugin.indexOf('"/crystals/auto"');
    expect(idx).toBeGreaterThan(-1);
    const block = plugin.slice(idx, idx + 400);
    expect(block).toMatch(/HEAVY_TIMEOUT_MS/);
  });
});
