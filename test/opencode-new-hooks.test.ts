import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const plugin = readFileSync(
  "plugin/opencode/agentmemory-capture.ts",
  "utf-8",
);

describe("OpenCode plugin: tool.execute.after typed hook", () => {
  it("registers a tool.execute.after handler", () => {
    expect(plugin).toMatch(/["']tool\.execute\.after["']\s*:\s*async/);
  });

  it("emits post_tool_use from tool.execute.after", () => {
    const start = plugin.indexOf('"tool.execute.after":');
    expect(start).toBeGreaterThan(-1);
    const block = plugin.slice(start, start + 1200);
    expect(block).toMatch(/observe\(\s*sid\s*,\s*["']post_tool_use["']/);
  });

  it("shares toolCallSetFor dedup with the message.part.updated tool branch", () => {
    const start = plugin.indexOf('"tool.execute.after":');
    const block = plugin.slice(start, start + 1200);
    expect(block).toMatch(/toolCallSetFor\(sid\)/);
  });
});

describe("OpenCode plugin: dispose cleanup hook", () => {
  it("registers a dispose handler", () => {
    expect(plugin).toMatch(/\bdispose\s*:\s*async/);
  });

  it("clears all session-scoped maps on dispose", () => {
    const start = plugin.indexOf("dispose:");
    expect(start).toBeGreaterThan(-1);
    const block = plugin.slice(start, start + 800);
    expect(block).toMatch(/stashedFiles\.clear\(\)/);
    expect(block).toMatch(/seenSubtaskIds\.clear\(\)/);
    expect(block).toMatch(/seenToolCallIds\.clear\(\)/);
    expect(block).toMatch(/contextInjectedSessions\.clear\(\)/);
    expect(block).toMatch(/startContextCache\.clear\(\)/);
    expect(block).toMatch(/lastSummarizeAt\.clear\(\)/);
  });

  it("flushes /session/end for the active session on dispose", () => {
    const start = plugin.indexOf("dispose:");
    const block = plugin.slice(start, start + 800);
    expect(block).toMatch(/post\(["']\/session\/end["']/);
  });
});

describe("OpenCode plugin: experimental.chat.messages.transform observer", () => {
  it("registers the messages.transform handler", () => {
    expect(plugin).toMatch(/["']experimental\.chat\.messages\.transform["']\s*:\s*async/);
  });

  it("emits a messages_transform observation", () => {
    const start = plugin.indexOf('"experimental.chat.messages.transform":');
    expect(start).toBeGreaterThan(-1);
    const block = plugin.slice(start, start + 600);
    expect(block).toMatch(/observe\(\s*sid\s*,\s*["']messages_transform["']/);
  });
});

describe("OpenCode plugin: command.execute.before typed hook", () => {
  it("registers the command.execute.before handler", () => {
    expect(plugin).toMatch(/["']command\.execute\.before["']\s*:\s*async/);
  });

  it("emits a command_before observation with command name", () => {
    const start = plugin.indexOf('"command.execute.before":');
    expect(start).toBeGreaterThan(-1);
    const block = plugin.slice(start, start + 600);
    expect(block).toMatch(/observe\(\s*sid\s*,\s*["']command_before["']/);
  });
});

describe("OpenCode plugin: permission.asked event", () => {
  it("handles permission.asked in the event switch", () => {
    expect(plugin).toMatch(/if\s*\(\s*type\s*===\s*["']permission\.asked["']\s*\)/);
  });

  it("emits a permission_asked observation", () => {
    const idx = plugin.indexOf('if (type === "permission.asked")');
    expect(idx).toBeGreaterThan(-1);
    const block = plugin.slice(idx, idx + 800);
    expect(block).toMatch(/observe\(\s*sid\s*,\s*["']permission_asked["']/);
  });
});
