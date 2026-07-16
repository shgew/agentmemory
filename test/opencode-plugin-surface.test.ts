/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const plugin = readFileSync(
  "plugin/opencode/agentmemory-capture.ts",
  "utf-8",
);

const EVENT_BRANCHES = [
  "session.created",
  "session.status",
  "session.compacted",
  "session.updated",
  "session.diff",
  "session.deleted",
  "session.error",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "file.edited",
  "permission.updated",
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "todo.updated",
  "vcs.branch.updated",
  "command.executed",
  "lsp.client.diagnostics",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "mcp.tools.changed",
  "pty.created",
  "pty.exited",
  "mcp.browser.open.failed",
  "installation.update-available",
] as const;

const TYPED_HOOKS = [
  "chat.message",
  "tool.execute.before",
  "tool.execute.after",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "experimental.compaction.autocontinue",
  "command.execute.before",
] as const;

const PART_SUBTYPES = [
  "subtask",
  "tool",
  "step-finish",
  "reasoning",
  "file",
  "patch",
  "compaction",
  "agent",
  "retry",
] as const;

describe("OpenCode plugin surface: event branches", () => {
  for (const ev of EVENT_BRANCHES) {
    it(`handles bus event ${ev}`, () => {
      const escaped = ev.replace(/\./g, "\\.");
      expect(plugin).toMatch(new RegExp(`if\\s*\\(\\s*event\\.type\\s*===\\s*["']${escaped}["']\\s*\\)`));
    });
  }
});

describe("OpenCode plugin surface: typed hooks", () => {
  for (const hook of TYPED_HOOKS) {
    it(`registers typed hook ${hook}`, () => {
      const escaped = hook.replace(/\./g, "\\.");
      expect(plugin).toMatch(new RegExp(`["']${escaped}["']\\s*:\\s*async`));
    });
  }

  it("registers dispose lifecycle hook", () => {
    expect(plugin).toMatch(/\bdispose\s*:\s*async/);
  });
});

describe("OpenCode plugin surface: message.part subtypes", () => {
  for (const sub of PART_SUBTYPES) {
    it(`handles part.type === ${sub}`, () => {
      expect(plugin).toMatch(new RegExp(`part\\.type\\s*===\\s*["']${sub}["']`));
    });
  }
});

describe("OpenCode plugin surface: dedup invariants", () => {
  it("subtask dedup uses seenSubtaskIds", () => {
    expect(plugin).toMatch(/subtaskSetFor\(sid\)/);
  });

  it("tool-call dedup uses seenToolCallIds shared by tool.execute.after and message.part tool branch", () => {
    expect(plugin).toMatch(/toolCallSetFor\(sid\)/);
    const occurrences = plugin.match(/toolCallSetFor\(sid\)/g) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });
});
