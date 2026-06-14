import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("config flag viewer banner policy", () => {
  const api = readFileSync("src/triggers/api.ts", "utf-8");
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("marks disabled auto-compress as informational", () => {
    expect(api).toMatch(
      /key:\s*"AGENTMEMORY_AUTO_COMPRESS"[\s\S]*?disabledBanner:\s*"info"/,
    );
  });

  it("viewer skips disabled flags whose banner policy is none", () => {
    expect(viewer).toMatch(
      /var disabledBanner = f\.disabledBanner \|\| 'warn';[\s\S]*?if \(disabledBanner === 'none'\) return;/,
    );
  });

  it("viewer can render disabled flags as info while preserving warn as default", () => {
    expect(viewer).toMatch(
      /var bannerKind = disabledBanner === 'info' \? 'info' : 'warn';/,
    );
    expect(viewer).toMatch(/kind:\s*bannerKind/);
    expect(viewer).toMatch(
      /icon:\s*bannerKind === 'info' \? '&#9881;' : '&#9888;'/,
    );
  });
});
