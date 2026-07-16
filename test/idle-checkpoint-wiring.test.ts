import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, "../src/index.ts"), "utf-8");
const apiSrc = readFileSync(join(here, "../src/triggers/api.ts"), "utf-8");

describe("idle-checkpoint poll wiring (src/index.ts)", () => {
  it("gates the idle-checkpoint poll on AGENTMEMORY_IDLE_CHECKPOINT_ENABLED", () => {
    expect(indexSrc).toMatch(/AGENTMEMORY_IDLE_CHECKPOINT_ENABLED/);
  });

  it("reads the poll interval from AGENTMEMORY_IDLE_CHECKPOINT_POLL_MS", () => {
    expect(indexSrc).toMatch(/AGENTMEMORY_IDLE_CHECKPOINT_POLL_MS/);
  });

  it("fires mem::session-sweep in idle-checkpoint mode", () => {
    expect(indexSrc).toMatch(/mem::session-sweep/);
    expect(indexSrc).toMatch(/mode:\s*["']idle-checkpoint["']/);
  });

  it("schedules the next poll only after the current sweep settles", () => {
    const idleBlock = indexSrc.slice(
      indexSrc.indexOf("const idleThresholdMs"),
      indexSrc.indexOf("const shutdown"),
    );
    expect(idleBlock).toMatch(/fireIdleCheckpoint\(\)\.finally\(scheduleIdleCheckpoint\)/);
    expect(idleBlock).not.toMatch(/setInterval/);
  });

  it("passes the idle threshold via getIdleCheckpointMs", () => {
    expect(indexSrc).toMatch(/getIdleCheckpointMs/);
  });

  it("only starts the poll when the idle threshold is positive (eager mode runs no poll)", () => {
    expect(indexSrc).toMatch(/idleThresholdMs\s*>\s*0/);
  });
});

describe("session sweep scheduler wiring", () => {
  it("schedules the next cron sweep after the current run settles", () => {
    const sweepBlock = indexSrc.slice(
      indexSrc.indexOf('getEnvVar("SESSION_SWEEP_ENABLED")'),
      indexSrc.indexOf("const idleThresholdMs"),
    );
    expect(sweepBlock).toMatch(
      /fireSessionSweep\(\)\.finally\(\(\)\s*=>\s*\{\s*scheduleNextSessionSweep\(\)/,
    );
  });

  it("reads recurring server settings through getEnvVar", () => {
    expect(indexSrc).not.toMatch(/process\.env\.(?:AUTO_FORGET|CONSOLIDATION|LESSON_DECAY|INSIGHT_DECAY|SESSION_SWEEP|AGENTMEMORY_IDLE_CHECKPOINT)/);
  });
});

describe("session-sweep mode pass-through (src/triggers/api.ts)", () => {
  it("validates the mode field against the allowed values", () => {
    expect(apiSrc).toMatch(/mode must be 'finalize' or 'idle-checkpoint'/);
  });

  it("forwards the mode field to the sweep payload", () => {
    expect(apiSrc).toMatch(/payload\.mode\s*=\s*body\.mode/);
  });
});
