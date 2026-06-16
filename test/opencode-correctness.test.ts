/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const plugin = readFileSync(
  "plugin/opencode/agentmemory-capture.ts",
  "utf-8",
);

describe("OpenCode plugin: session/checkpoint replaces summarize debounce", () => {
  it("does not handle deprecated session.idle (canonical signal is session.status idle)", () => {
    expect(plugin).not.toMatch(/if\s*\(\s*event\.type\s*===\s*["']session\.idle["']\s*\)/);
  });

  it("posts /session/checkpoint on session.status idle", () => {
    const statusBlock = plugin.slice(
      plugin.indexOf('if (event.type === "session.status")'),
      plugin.indexOf('if (event.type === "session.compacted")'),
    );
    expect(statusBlock).toMatch(/post\(["']\/session\/checkpoint["']/);
  });

  it("posts /session/checkpoint on session.compacted", () => {
    const compactedBlock = plugin.slice(
      plugin.indexOf('if (event.type === "session.compacted")'),
      plugin.indexOf('if (event.type === "session.updated")'),
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
      plugin.indexOf('if (event.type === "message.updated")'),
      plugin.indexOf('if (event.type === "message.removed")'),
    );
    expect(messageUpdatedBlock).toMatch(/info\.role\s*===\s*["']user["']/);
    expect(messageUpdatedBlock).toMatch(/observe\(\s*sid\s*,\s*["']user_message["']/);
  });
});

describe("OpenCode plugin: resumed-session re-injection", () => {
  it("clears contextInjectedSessions when session.updated arrives without prior session.created", () => {
    const updatedBlock = plugin.slice(
      plugin.indexOf('if (event.type === "session.updated")'),
      plugin.indexOf('if (event.type === "session.diff")'),
    );
    expect(updatedBlock).toMatch(/contextInjectedSessions\.delete\(/);
    expect(updatedBlock).toMatch(/stashedFiles\.has\(/);
  });
});

describe("OpenCode plugin: type-narrowed event dispatcher", () => {
  it("does not contain (event as any).properties", () => {
    expect(plugin).not.toMatch(/\(\s*event\s+as\s+any\s*\)\.properties/);
  });

  it("does not contain const type: string = event.type", () => {
    expect(plugin).not.toMatch(/const\s+type\s*:\s*string\s*=\s*event\.type/);
  });

  it("uses discriminant narrowing via event.type === literal", () => {
    expect(plugin).toMatch(/if\s*\(\s*event\.type\s*===\s*["']session\.created["']\s*\)/);
  });
});
