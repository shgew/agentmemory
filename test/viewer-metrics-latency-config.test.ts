import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("viewer metrics latency color thresholds", () => {
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("keeps the existing default thresholds", () => {
    expect(viewer).toContain("var DEFAULT_AVG_LATENCY_THRESHOLDS = { warningMs: 200, criticalMs: 1000 }");
    expect(viewer).toContain("if (value === null || value === undefined || value === '') return null");
  });

  it("supports query, localStorage, and viewer config overrides", () => {
    expect(viewer).toContain("params.get('avgLatencyWarningMs')");
    expect(viewer).toContain("params.get('avgLatencyCriticalMs')");
    expect(viewer).toContain("agentmemory-avg-latency-warning-ms");
    expect(viewer).toContain("agentmemory-avg-latency-critical-ms");
    expect(viewer).toContain("window.agentmemoryViewerConfig || window.AGENTMEMORY_VIEWER_CONFIG");
    expect(viewer).toContain("VIEWER_CONFIG.avgLatencyThresholds");
  });

  it("uses the configured thresholds when rendering latency colors", () => {
    expect(viewer).toContain("function avgLatencyColor(avgLatencyMs)");
    expect(viewer).toContain("var latencyColor = avgLatencyColor(m.avgLatencyMs)");
    expect(viewer).not.toContain("m.avgLatencyMs > 1000 ? 'var(--red)' : m.avgLatencyMs > 200 ? 'var(--yellow)' : 'var(--green)'");
  });
});
