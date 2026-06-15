import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MemoryProvider } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

describe("ResilientProvider LLM queue", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, AGENTMEMORY_LLM_CONCURRENCY: "1" };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("serializes concurrent LLM calls by default", async () => {
    const { ResilientProvider } = await import("../src/providers/resilient.js");
    let active = 0;
    let maxActive = 0;
    const inner: MemoryProvider = {
      name: "inner",
      async compress() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return "ok";
      },
      async summarize() {
        return "ok";
      },
    };
    const provider = new ResilientProvider(inner);

    await Promise.all([
      provider.compress("s", "a"),
      provider.compress("s", "b"),
      provider.compress("s", "c"),
    ]);

    expect(maxActive).toBe(1);
  });

  it("honors AGENTMEMORY_LLM_CONCURRENCY", async () => {
    process.env.AGENTMEMORY_LLM_CONCURRENCY = "2";
    const { ResilientProvider } = await import("../src/providers/resilient.js");
    let active = 0;
    let maxActive = 0;
    const inner: MemoryProvider = {
      name: "inner",
      async compress() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return "ok";
      },
      async summarize() {
        return "ok";
      },
    };
    const provider = new ResilientProvider(inner);

    await Promise.all([
      provider.compress("s", "a"),
      provider.compress("s", "b"),
      provider.compress("s", "c"),
      provider.compress("s", "d"),
    ]);

    expect(maxActive).toBe(2);
  });

  it("fails fast when the circuit breaker stays open past AGENTMEMORY_LLM_TIMEOUT_MS", async () => {
    process.env.AGENTMEMORY_LLM_TIMEOUT_MS = "50";
    process.env.AGENTMEMORY_CIRCUIT_BREAKER_POLL_MS = "10";
    const { ResilientProvider } = await import("../src/providers/resilient.js");
    const inner: MemoryProvider = {
      name: "inner",
      async compress() {
        throw new Error("provider down");
      },
      async summarize() {
        throw new Error("provider down");
      },
    };
    const provider = new ResilientProvider(inner);
    await expect(provider.compress("s", "a")).rejects.toThrow("provider down");
    await expect(provider.compress("s", "b")).rejects.toThrow("provider down");
    await expect(provider.compress("s", "c")).rejects.toThrow("provider down");
    const startedAt = Date.now();
    await expect(provider.compress("s", "d")).rejects.toThrow(
      /circuit breaker open longer than 50ms/,
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
