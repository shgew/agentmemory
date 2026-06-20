import { describe, it, expect, afterEach } from "vitest";

import {
  getAllTools,
  getVisibleTools,
  parseToolDisableList,
} from "../src/mcp/tools-registry.js";

const ENV = "AGENTMEMORY_TOOLS_DISABLE";

describe("parseToolDisableList", () => {
  it("returns empty set for nullish/empty input", () => {
    expect(parseToolDisableList(undefined).size).toBe(0);
    expect(parseToolDisableList(null).size).toBe(0);
    expect(parseToolDisableList("").size).toBe(0);
    expect(parseToolDisableList("   ").size).toBe(0);
  });

  it("parses comma-separated tool names", () => {
    const set = parseToolDisableList("memory_vision_search,memory_mesh_sync");
    expect(set.has("memory_vision_search")).toBe(true);
    expect(set.has("memory_mesh_sync")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("parses whitespace-separated tool names", () => {
    const set = parseToolDisableList("memory_vision_search   memory_mesh_sync\nmemory_team_share");
    expect(set.size).toBe(3);
  });

  it("trims whitespace and tolerates trailing commas", () => {
    const set = parseToolDisableList("  memory_a , memory_b ,, ");
    expect(set.has("memory_a")).toBe(true);
    expect(set.has("memory_b")).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe("getVisibleTools env filter", () => {
  const originalDisable = process.env[ENV];
  const originalMode = process.env["AGENTMEMORY_TOOLS"];

  afterEach(() => {
    if (originalDisable === undefined) delete process.env[ENV];
    else process.env[ENV] = originalDisable;
    if (originalMode === undefined) delete process.env["AGENTMEMORY_TOOLS"];
    else process.env["AGENTMEMORY_TOOLS"] = originalMode;
  });

  it("returns the full set when env is unset", () => {
    delete process.env[ENV];
    delete process.env["AGENTMEMORY_TOOLS"];
    expect(getVisibleTools().length).toBe(getAllTools().length);
  });

  it("drops named tools from default 'all' mode", () => {
    delete process.env["AGENTMEMORY_TOOLS"];
    process.env[ENV] =
      "memory_vision_search,memory_mesh_sync,memory_obsidian_export";
    const visible = getVisibleTools().map((t) => t.name);
    expect(visible).not.toContain("memory_vision_search");
    expect(visible).not.toContain("memory_mesh_sync");
    expect(visible).not.toContain("memory_obsidian_export");
    expect(visible).toContain("memory_save");
    expect(visible).toContain("memory_smart_search");
    expect(visible.length).toBe(getAllTools().length - 3);
  });

  it("applies on top of 'core' mode", () => {
    process.env["AGENTMEMORY_TOOLS"] = "core";
    process.env[ENV] = "memory_reflect";
    const visible = getVisibleTools().map((t) => t.name);
    expect(visible).not.toContain("memory_reflect");
    expect(visible).toContain("memory_save");
    expect(visible).toContain("memory_recall");
  });

  it("silently ignores unknown tool names", () => {
    delete process.env["AGENTMEMORY_TOOLS"];
    process.env[ENV] = "memory_does_not_exist,memory_save";
    const visible = getVisibleTools().map((t) => t.name);
    expect(visible).not.toContain("memory_save");
    expect(visible.length).toBe(getAllTools().length - 1);
  });
});
