import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const plugin = readFileSync(
  "plugin/opencode/agentmemory-capture.ts",
  "utf-8",
);

describe("OpenCode plugin: summarize debounce", () => {
  it("declares a per-session lastSummarizeAt map", () => {
    expect(plugin).toMatch(
      /const\s+lastSummarizeAt\s*=\s*new Map<string,\s*number>/,
    );
  });

  it("reads OPENCODE_AGENTMEMORY_SUMMARIZE_DEBOUNCE_MS with a 600_000 default", () => {
    expect(plugin).toMatch(
      /OPENCODE_AGENTMEMORY_SUMMARIZE_DEBOUNCE_MS[\s\S]*?600[_]?000/,
    );
  });

  it("exposes a shouldSummarize helper that gates /summarize calls", () => {
    expect(plugin).toMatch(/function\s+shouldSummarize\s*\(/);
  });

  it("gates the session.status idle /summarize behind shouldSummarize", () => {
    const idleBlock = plugin.slice(
      plugin.indexOf('if (type === "session.status")'),
      plugin.indexOf('if (type === "session.compacted")'),
    );
    expect(idleBlock).toMatch(/shouldSummarize\(/);
    expect(idleBlock).toMatch(/post\(["']\/summarize["']/);
  });

  it("gates the session.compacted /summarize behind shouldSummarize", () => {
    const compactedBlock = plugin.slice(
      plugin.indexOf('if (type === "session.compacted")'),
      plugin.indexOf('if (type === "session.updated")'),
    );
    expect(compactedBlock).toMatch(/shouldSummarize\(/);
    expect(compactedBlock).toMatch(/post\(["']\/summarize["']/);
  });

  it("clears lastSummarizeAt for the session on session.deleted", () => {
    const deletedBlock = plugin.slice(
      plugin.indexOf('if (type === "session.deleted")'),
      plugin.indexOf('if (type === "session.error")'),
    );
    expect(deletedBlock).toMatch(/lastSummarizeAt\.delete\(sid\)/);
  });
});

describe("OpenCode plugin: user message capture", () => {
  it("emits an observation when message.updated fires with role user", () => {
    const messageUpdatedBlock = plugin.slice(
      plugin.indexOf('if (type === "message.updated")'),
      plugin.indexOf('if (type === "message.removed")'),
    );
    expect(messageUpdatedBlock).toMatch(/info\.role\s*===\s*["']user["']/);
    expect(messageUpdatedBlock).toMatch(/observe\(\s*sid\s*,\s*["']user_message["']/);
  });
});

describe("OpenCode plugin: resumed-session re-injection", () => {
  it("clears contextInjectedSessions when session.updated arrives without prior session.created", () => {
    const updatedBlock = plugin.slice(
      plugin.indexOf('if (type === "session.updated")'),
      plugin.indexOf('if (type === "session.diff")'),
    );
    expect(updatedBlock).toMatch(/contextInjectedSessions\.delete\(/);
    expect(updatedBlock).toMatch(/stashedFiles\.has\(/);
  });
});
