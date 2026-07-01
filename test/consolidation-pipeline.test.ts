import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationDecayDays: () => 30,
  isConsolidationEnabled: vi.fn(() => true),
}));

import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { registerReflectFunctions } from "../src/functions/reflect.js";
import { isConsolidationEnabled } from "../src/config.js";
import type { SessionSummary, Memory, SemanticMemory, ProceduralMemory } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      const explicit = store.get(scope)?.get(key);
      if (explicit !== undefined) return explicit as T;
      // Mirror production: reflect reads the graph via readGraphSnapshot
      // (a kv.get on mem:graph:snapshot), which graph-extract maintains as a
      // top-degree view of the graph scopes. Tests seed mem:graph:nodes /
      // mem:graph:edges, so synthesize that snapshot on read.
      if (scope === "mem:graph:snapshot" && key === "current") {
        const nodes = Array.from(
          store.get("mem:graph:nodes")?.values() ?? [],
        ) as Array<{ stale?: boolean }>;
        const edges = Array.from(
          store.get("mem:graph:edges")?.values() ?? [],
        ) as Array<{ stale?: boolean }>;
        if (nodes.length === 0 && edges.length === 0) return null;
        const liveNodes = nodes.filter((n) => !n.stale);
        const liveEdges = edges.filter((e) => !e.stale);
        return {
          version: 1,
          topNodes: liveNodes,
          topEdges: liveEdges,
          topDegrees: {},
          stats: {
            totalNodes: liveNodes.length,
            totalEdges: liveEdges.length,
            nodesByType: {},
            edgesByType: {},
          },
          updatedAt: new Date().toISOString(),
          dirty: false,
        } as T;
      }
      return null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeSummary(i: number): SessionSummary {
  return {
    sessionId: `ses_${i}`,
    project: "test-project",
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
    title: `Session ${i} summary`,
    narrative: `Worked on feature ${i}`,
    keyDecisions: [`Decision ${i}`],
    filesModified: [`src/file${i}.ts`],
    concepts: ["typescript", "testing"],
    observationCount: 5,
  };
}

function makePattern(i: number): Memory {
  return {
    id: `mem_${i}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    type: "pattern",
    title: `Pattern ${i}`,
    content: `Always do thing ${i}`,
    concepts: ["testing"],
    files: [],
    sessionIds: ["ses_1", "ses_2"],
    strength: 5,
    version: 1,
    isLatest: true,
  };
}

describe("Consolidation Pipeline", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
  });

  it("pipeline skips semantic when fewer than 5 summaries", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const semantic = result.results.semantic as { skipped: boolean; reason: string };
    expect(semantic.skipped).toBe(true);
    expect(semantic.reason).toContain("fewer than 5");
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("pipeline skips procedural when fewer than 2 patterns", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const mem: Memory = {
      ...makePattern(1),
      sessionIds: ["ses_1", "ses_2"],
    };
    await kv.set("mem:memories", "mem_1", mem);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const procedural = result.results.procedural as { skipped: boolean; reason: string };
    expect(procedural.skipped).toBe(true);
    expect(procedural.reason).toContain("fewer than 2");
  });

  it("with enough summaries, creates semantic memories from provider response", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const semantic = result.results.semantic as { newFacts: number };
    expect(semantic.newFacts).toBe(1);

    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored.length).toBe(1);
    expect(stored[0].fact).toBe("TypeScript is the primary language");
    expect(stored[0].confidence).toBe(0.9);
  });

  it("with enough patterns, creates procedural memories from provider response", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Test Workflow" trigger="when writing tests"><step>Create test file</step><step>Write assertions</step></procedure></procedures>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const procedural = result.results.procedural as { newProcedures: number };
    expect(procedural.newProcedures).toBe(1);

    const stored = await kv.list<ProceduralMemory>("mem:procedural");
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe("Test Workflow");
    expect(stored[0].steps.length).toBe(2);
    expect(stored[0].triggerCondition).toBe("when writing tests");
  });

  it("consolidation records an audit entry", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });

    const audits = await kv.list("mem:audit");
    expect(audits.length).toBe(1);
  });

  it("pipeline returns early when consolidation is disabled", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {})) as {
      success: boolean;
      skipped?: boolean;
      reason?: string;
    };

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("CONSOLIDATION_ENABLED");
    expect(provider.summarize).not.toHaveBeenCalled();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  it("pipeline proceeds with force=true even when consolidation is disabled", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      force: true,
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    expect(result.results).toBeDefined();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  it("reflect gate skips automatic reflect within 24h of last success", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    const reflectFn = vi.fn().mockResolvedValue({ success: true });
    sdk.registerFunction("mem::reflect", reflectFn);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await kv.set("mem:config", "reflect:last-success:global", { at: new Date().toISOString() });

    const result = (await sdk.trigger("mem::consolidate-pipeline", { tier: "all" })) as {
      results: Record<string, unknown>;
    };
    const reflect = result.results.reflect as { skipped?: boolean };
    expect(reflect.skipped).toBe(true);
    expect(reflectFn).not.toHaveBeenCalled();
  });

  it("reflect gate runs reflect after 24h and updates the watermark after a full pass", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    const reflectFn = vi.fn().mockResolvedValue({ success: true, fullPassComplete: true, newInsights: 1 });
    sdk.registerFunction("mem::reflect", reflectFn);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await kv.set("mem:config", "reflect:last-success:global", {
      at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    const result = (await sdk.trigger("mem::consolidate-pipeline", { tier: "all" })) as {
      results: Record<string, unknown>;
    };
    const reflect = result.results.reflect as { skipped?: boolean };
    expect(reflect.skipped).toBeUndefined();
    expect(reflectFn).toHaveBeenCalled();
    const wm = await kv.get<{ at: string }>("mem:config", "reflect:last-success:global");
    expect(new Date(wm!.at).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("reflect gate does not write the watermark after a partial reflect pass", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    const reflectFn = vi.fn().mockResolvedValue({ success: true, fullPassComplete: false, newInsights: 0 });
    sdk.registerFunction("mem::reflect", reflectFn);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await sdk.trigger("mem::consolidate-pipeline", { tier: "all" });

    expect(reflectFn).toHaveBeenCalled();
    const wm = await kv.get("mem:config", "reflect:last-success:global");
    expect(wm).toBeNull();
  });

  it("continues procedural and decay tiers after a partial reflect pass", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    sdk.registerFunction("mem::reflect", vi.fn().mockResolvedValue({
      success: true,
      fullPassComplete: false,
      budgetExhausted: true,
    }));
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", { tier: "all" })) as {
      results: Record<string, unknown>;
    };

    expect(result.results.procedural).toBeDefined();
    expect(result.results.decay).toBeDefined();
  });

  it("explicit tier=reflect bypasses the gate", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    const reflectFn = vi.fn().mockResolvedValue({ success: true });
    sdk.registerFunction("mem::reflect", reflectFn);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await kv.set("mem:config", "reflect:last-success:global", { at: new Date().toISOString() });

    await sdk.trigger("mem::consolidate-pipeline", { tier: "reflect" });
    expect(reflectFn).toHaveBeenCalled();
  });

  it("reflect gate does not write the watermark when reflect fails", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    sdk.registerFunction("mem::reflect", vi.fn().mockResolvedValue({ success: false, error: "boom" }));
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await sdk.trigger("mem::consolidate-pipeline", { tier: "all" });

    const wm = await kv.get("mem:config", "reflect:last-success:global");
    expect(wm).toBeNull();
  });

  it("reflect gate does not write the watermark when the real reflect fails on every cluster", async () => {
    const now = new Date().toISOString();
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockRejectedValue(new Error("provider down")),
    };
    registerReflectFunctions(sdk as never, kv as never, provider as never);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await kv.set("mem:graph:nodes", "n1", {
      id: "node_security", type: "concept", name: "security",
      properties: {}, sourceObservationIds: [], createdAt: now,
    });
    await kv.set("mem:graph:nodes", "n2", {
      id: "node_validation", type: "concept", name: "validation",
      properties: {}, sourceObservationIds: [], createdAt: now,
    });
    await kv.set("mem:graph:edges", "e1", {
      id: "e1", type: "related_to", sourceNodeId: "node_security",
      targetNodeId: "node_validation", weight: 1, sourceObservationIds: [], createdAt: now,
    });
    for (const [i, fact] of [
      "always validate security inputs",
      "testing improves security coverage",
      "validation prevents injection",
    ].entries()) {
      await kv.set("mem:semantic", `s${i}`, {
        id: `s${i}`, fact, confidence: 0.8, sourceSessionIds: [], sourceMemoryIds: [],
        accessCount: 1, lastAccessedAt: now, strength: 0.8, createdAt: now, updatedAt: now,
      });
    }

    await sdk.trigger("mem::consolidate-pipeline", { tier: "all" });

    const wm = await kv.get("mem:config", "reflect:last-success:global");
    expect(wm).toBeNull();
  });
});
