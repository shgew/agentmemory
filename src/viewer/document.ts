import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VIEWER_NONCE_PLACEHOLDER,
  createViewerNonce,
  buildViewerCsp,
} from "../auth.js";
import { VERSION } from "../version.js";

const VIEWER_VERSION_PLACEHOLDER = "__AGENTMEMORY_VERSION__";
const VIEWER_CONFIG_SCRIPT_PLACEHOLDER = "__AGENTMEMORY_VIEWER_CONFIG_SCRIPT__";

function parsePositiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function buildViewerConfigScript(nonce: string): string {
  const warningMs = parsePositiveNumber(process.env.AGENTMEMORY_AVG_LATENCY_WARNING_MS);
  const criticalMs = parsePositiveNumber(process.env.AGENTMEMORY_AVG_LATENCY_CRITICAL_MS);
  const avgLatencyThresholds: Record<string, number> = {};
  if (warningMs !== null) avgLatencyThresholds.warningMs = warningMs;
  if (criticalMs !== null) avgLatencyThresholds.criticalMs = criticalMs;
  if (Object.keys(avgLatencyThresholds).length === 0) return "";
  const config = { avgLatencyThresholds };
  return `<script nonce="${nonce}">window.agentmemoryViewerConfig = ${JSON.stringify(config)};</script>`;
}

function loadViewerTemplate(): string | null {
  const base = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(base, "..", "src", "viewer", "index.html"),
    join(base, "..", "viewer", "index.html"),
    join(base, "viewer", "index.html"),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf-8");
    } catch {}
  }
  return null;
}

export function renderViewerDocument():
  | { found: true; html: string; csp: string }
  | { found: false } {
  const template = loadViewerTemplate();
  if (!template) {
    return { found: false };
  }

  const nonce = createViewerNonce();
  const configScript = buildViewerConfigScript(nonce);
  const html = template
    .replaceAll(VIEWER_NONCE_PLACEHOLDER, nonce)
    .replaceAll(VIEWER_VERSION_PLACEHOLDER, VERSION)
    .replaceAll(VIEWER_CONFIG_SCRIPT_PLACEHOLDER, configScript);
  return {
    found: true,
    html,
    csp: buildViewerCsp(nonce),
  };
}
