import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("viewer flicker guards", () => {
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("keeps dashboard content visible during refreshes", () => {
    expect(viewer).toMatch(/function refreshDashboard\(\) \{\s*loadDashboard\(\{ preserveContent: true \}\);\s*\}/);
    expect(viewer).toMatch(/if \(!opts\.preserveContent \|\| !state\.dashboard\.loaded\) \{\s*el\.innerHTML = '<div class="loading">Loading dashboard\.\.\.<\/div>';\s*\}/);
    expect(viewer).not.toMatch(/state\.dashboard\.loaded\s*=\s*false/);
  });

  it("debounces live dashboard refreshes", () => {
    expect(viewer).toMatch(/var dashboardRefreshTimer = null/);
    expect(viewer).toMatch(/function scheduleDashboardRefresh\(delay\)/);
    expect(viewer).toMatch(/scheduleDashboardRefresh\(\);/);
  });

  it("serializes dashboard loads", () => {
    expect(viewer).toMatch(/var dashboardLoadInFlight = false/);
    expect(viewer).toMatch(/dashboardReloadPending = true/);
    expect(viewer).toMatch(/dashboardLoadInFlight = false/);
  });
});
