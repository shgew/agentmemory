import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// OpenCode plugin needs zero-config memory injection. Plugin
// already wires experimental.chat.system.transform; this PR threads
// the /session/start context through a cache so injection happens
// without a second /context fetch and is documented as the
// SessionStart-equivalent behaviour.
describe("OpenCode plugin auto-context injection (#431)", () => {
  const plugin = readFileSync(
    "plugin/opencode/agentmemory-capture.ts",
    "utf-8",
  );

  it("captures context returned by POST /session/start", () => {
    expect(plugin).toMatch(/startContextCache\s*=\s*new Map<string,\s*string>/);
    expect(plugin).toMatch(
      /postJson\(["']\/session\/start["']/,
    );
    // Snapshot `activeSessionId` into a local before the await so the cached
    // context binds to the session that opened it, not a later one.
    expect(plugin).toMatch(
      /const\s+sessionId\s*=\s*activeSessionId[\s\S]*?startContextCache\.set\(sessionId/,
    );
  });

  it("chat.system.transform reads cached context first, falls back to /context", () => {
    expect(plugin).toMatch(/startContextCache\.get\(sid\)/);
    expect(plugin).toMatch(/postJson\(["']\/context["']/);
    expect(plugin).toMatch(/startContextCache\.delete\(sid\)/);
  });

  it("session.deleted clears the cache to avoid stale entries", () => {
    const deletedBlock = plugin.slice(plugin.indexOf("session.deleted"));
    expect(deletedBlock).toMatch(/startContextCache\.delete\(sid\)/);
  });
});

describe("OpenCode plugin /enrich idempotence", () => {
  const plugin = readFileSync(
    "plugin/opencode/agentmemory-capture.ts",
    "utf-8",
  );

  it("drops enriched files from the stash on any non-null response, not only non-empty context", () => {
    const enrichBlock = plugin.slice(plugin.indexOf('"/enrich"'));
    // Clearing on enrichResult !== null (server processed the files) stops
    // empty-result files being re-sent to /enrich on every later transform.
    expect(enrichBlock).toMatch(
      /if \(enrichResult !== null\)\s*\{[\s\S]*?for \(const f of files\) stash\.delete\(f\)/,
    );
  });
});


describe("OpenCode plugin instruction-block removal", () => {
  const plugin = readFileSync(
    "plugin/opencode/agentmemory-capture.ts",
    "utf-8",
  );

  it("no longer injects a hardcoded AGENTMEMORY_INSTRUCTIONS block (deduped against the AGENTS.md doctrine)", () => {
    expect(plugin).not.toMatch(/AGENTMEMORY_INSTRUCTIONS/);
    expect(plugin).not.toMatch(/<agentmemory-instructions>/);
  });

  it("still injects live /context into the system prompt", () => {
    expect(plugin).toMatch(/postJson\(["']\/context["']/);
    expect(plugin).toMatch(/output\.system\.push\(ctx\)/);
  });
});