import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderViewerDocument } from "../src/viewer/document.js";

describe("viewer document env-driven config injection", () => {
  const ENV_KEYS = [
    "AGENTMEMORY_AVG_LATENCY_WARNING_MS",
    "AGENTMEMORY_AVG_LATENCY_CRITICAL_MS",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const prior = saved[k];
      if (prior === undefined) delete process.env[k];
      else process.env[k] = prior;
    }
  });

  it("omits the config script when neither env var is set", () => {
    const rendered = renderViewerDocument();
    expect(rendered.found).toBe(true);
    if (!rendered.found) return;
    expect(rendered.html).not.toContain("window.agentmemoryViewerConfig =");
    expect(rendered.html).not.toContain("__AGENTMEMORY_VIEWER_CONFIG_SCRIPT__");
  });

  it("inlines window.agentmemoryViewerConfig when both env vars are set", () => {
    process.env.AGENTMEMORY_AVG_LATENCY_WARNING_MS = "300";
    process.env.AGENTMEMORY_AVG_LATENCY_CRITICAL_MS = "1500";
    const rendered = renderViewerDocument();
    expect(rendered.found).toBe(true);
    if (!rendered.found) return;
    expect(rendered.html).toContain(
      'window.agentmemoryViewerConfig = {"avgLatencyThresholds":{"warningMs":300,"criticalMs":1500}};',
    );
  });

  it("inlines just one threshold when only one env var is set", () => {
    process.env.AGENTMEMORY_AVG_LATENCY_WARNING_MS = "250";
    const rendered = renderViewerDocument();
    expect(rendered.found).toBe(true);
    if (!rendered.found) return;
    expect(rendered.html).toContain(
      'window.agentmemoryViewerConfig = {"avgLatencyThresholds":{"warningMs":250}};',
    );
  });

  it("ignores invalid env values (empty, non-numeric, negative)", () => {
    process.env.AGENTMEMORY_AVG_LATENCY_WARNING_MS = "";
    process.env.AGENTMEMORY_AVG_LATENCY_CRITICAL_MS = "abc";
    const rendered = renderViewerDocument();
    expect(rendered.found).toBe(true);
    if (!rendered.found) return;
    expect(rendered.html).not.toContain("window.agentmemoryViewerConfig =");

    process.env.AGENTMEMORY_AVG_LATENCY_WARNING_MS = "-100";
    process.env.AGENTMEMORY_AVG_LATENCY_CRITICAL_MS = "NaN";
    const rendered2 = renderViewerDocument();
    expect(rendered2.found).toBe(true);
    if (!rendered2.found) return;
    expect(rendered2.html).not.toContain("window.agentmemoryViewerConfig =");
  });

  it("attaches the same nonce to the injected script as the CSP", () => {
    process.env.AGENTMEMORY_AVG_LATENCY_WARNING_MS = "300";
    const rendered = renderViewerDocument();
    expect(rendered.found).toBe(true);
    if (!rendered.found) return;
    const match = rendered.csp.match(/script-src 'nonce-([^']+)'/);
    expect(match).not.toBeNull();
    if (!match) return;
    const nonce = match[1];
    expect(rendered.html).toContain(
      `<script nonce="${nonce}">window.agentmemoryViewerConfig =`,
    );
  });
});
