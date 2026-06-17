import { describe, it, expect, afterEach, vi } from "vitest";

import { getIdleCheckpointMs } from "../src/config.js";

describe("getIdleCheckpointMs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 600000 when neither env is set", () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "");
    expect(getIdleCheckpointMs()).toBe(600_000);
  });

  it("uses AGENTMEMORY_IDLE_CHECKPOINT_MS when set", () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "300000");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "");
    expect(getIdleCheckpointMs()).toBe(300_000);
  });

  it("falls back to AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS when only the alias is set", () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "900000");
    expect(getIdleCheckpointMs()).toBe(900_000);
  });

  it("prefers AGENTMEMORY_IDLE_CHECKPOINT_MS over the debounce alias when both are set", () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "120000");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "900000");
    expect(getIdleCheckpointMs()).toBe(120_000);
  });

  it("returns 0 when AGENTMEMORY_IDLE_CHECKPOINT_MS=0 (eager opt-in)", () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "0");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "");
    expect(getIdleCheckpointMs()).toBe(0);
  });

  it("honors the debounce alias =0 when the idle env is unset", () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "0");
    expect(getIdleCheckpointMs()).toBe(0);
  });

  it("ignores negative or non-numeric values and uses the default", () => {
    vi.stubEnv("AGENTMEMORY_IDLE_CHECKPOINT_MS", "-5");
    vi.stubEnv("AGENTMEMORY_CHECKPOINT_DEBOUNCE_MS", "");
    expect(getIdleCheckpointMs()).toBe(600_000);
  });
});
