import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { resolveGraphProviderConfig } from "../src/providers/index.js";
import type { ProviderConfig } from "../src/types.js";

describe("resolveGraphProviderConfig", () => {
  const ORIGINAL_ENV = { ...process.env };
  const base: ProviderConfig = {
    provider: "openai",
    model: "base-model",
    maxTokens: 4096,
    baseURL: "http://example/v1",
  };

  beforeEach(() => {
    delete process.env.AGENTMEMORY_GRAPH_MODEL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns the base model when AGENTMEMORY_GRAPH_MODEL is unset", () => {
    const result = resolveGraphProviderConfig(base);
    expect(result.model).toBe("base-model");
    expect(result.provider).toBe("openai");
    expect(result.maxTokens).toBe(4096);
    expect(result.baseURL).toBe("http://example/v1");
  });

  it("overrides only the model when AGENTMEMORY_GRAPH_MODEL is set", () => {
    process.env.AGENTMEMORY_GRAPH_MODEL = "graph-model";
    const result = resolveGraphProviderConfig(base);
    expect(result.model).toBe("graph-model");
    expect(result.provider).toBe("openai");
    expect(result.maxTokens).toBe(4096);
    expect(result.baseURL).toBe("http://example/v1");
  });
});
