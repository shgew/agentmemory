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
});
