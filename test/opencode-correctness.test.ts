import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const plugin = readFileSync(
  "plugin/opencode/agentmemory-capture.ts",
  "utf-8",
);

describe("OpenCode plugin: session/checkpoint replaces summarize debounce", () => {
  it("posts /session/checkpoint on session.idle", () => {
    const idleBlock = plugin.slice(
      plugin.indexOf('if (type === "session.idle")'),
      plugin.indexOf('// \u2500\u2500 session.status \u2500\u2500'),
    );
    expect(idleBlock).toMatch(/post\(["']\/session\/checkpoint["']/);
  });

  it("posts /session/checkpoint on session.status idle", () => {
    const statusBlock = plugin.slice(
      plugin.indexOf('if (type === "session.status")'),
      plugin.indexOf('if (type === "session.compacted")'),
    );
    expect(statusBlock).toMatch(/post\(["']\/session\/checkpoint["']/);
  });

  it("posts /session/checkpoint on session.compacted", () => {
    const compactedBlock = plugin.slice(
      plugin.indexOf('if (type === "session.compacted")'),
      plugin.indexOf('if (type === "session.updated")'),
    );
    expect(compactedBlock).toMatch(/post\(["']\/session\/checkpoint["']/);
  });

  it("does not contain shouldSummarize, lastSummarizeAt, or SUMMARIZE_DEBOUNCE_MS", () => {
    expect(plugin).not.toMatch(/shouldSummarize/);
    expect(plugin).not.toMatch(/lastSummarizeAt/);
    expect(plugin).not.toMatch(/SUMMARIZE_DEBOUNCE_MS/);
  });

  it("does not call /summarize", () => {
    expect(plugin).not.toMatch(/post\(["']\/summarize["']/);
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
