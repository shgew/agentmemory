import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationDecayDays: () => 30,
  getEnvVar: vi.fn(() => undefined),
  isConsolidationEnabled: vi.fn(() => true),
  isInsightSynthesisEnabled: vi.fn(() => true),
  isProceduralExtractionEnabled: vi.fn(() => true),
}));

import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { registerReflectFunctions } from "../src/functions/reflect.js";
import {
  getEnvVar,
  isConsolidationEnabled,
  isInsightSynthesisEnabled,
  isProceduralExtractionEnabled,
} from "../src/config.js";
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
    // Existing tests assume the reflect + procedural tiers run; default the
    // new kill-switch flags to enabled here and let the skip-tests override.
    vi.mocked(isInsightSynthesisEnabled).mockReturnValue(true);
    vi.mocked(isProceduralExtractionEnabled).mockReturnValue(true);
    vi.mocked(getEnvVar).mockReturnValue(undefined);
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

  it.each([
    ["empty", ""],
    ["malformed", '<facts><fact confidence="0.9">Incomplete</facts>'],
    ["empty fact", '<facts><fact confidence="0.9"> </fact></facts>'],
    ["empty confidence", '<facts><fact confidence=" ">Fact</fact></facts>'],
    ["unexpected wrapper", "prefix<facts></facts>suffix"],
  ])("retries unchanged summaries after %s semantic output", async (_label, output) => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi
        .fn()
        .mockResolvedValueOnce(output)
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.9">Recovered fact</fact></facts>',
        ),
    };
    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      provider as never,
    );
    for (let index = 0; index < 5; index++) {
      await kv.set("mem:summaries", `ses_${index}`, makeSummary(index));
    }

    const first = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { results: { semantic: { error?: string } } };
    expect(first.results.semantic.error).toBeDefined();
    expect(
      await kv.get("mem:config", "semantic:last-input:global"),
    ).toBeNull();

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });

    expect(provider.summarize).toHaveBeenCalledTimes(2);
    expect(await kv.list<SemanticMemory>("mem:semantic")).toHaveLength(1);
  });

  it("watermarks a valid empty semantic envelope", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue("<facts></facts>"),
    };
    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      provider as never,
    );
    for (let index = 0; index < 5; index++) {
      await kv.set("mem:summaries", `ses_${index}`, makeSummary(index));
    }

    const first = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { results: { semantic: { newFacts: number } } };
    const second = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { results: { semantic: { skipped?: boolean } } };

    expect(first.results.semantic.newFacts).toBe(0);
    expect(second.results.semantic.skipped).toBe(true);
    expect(provider.summarize).toHaveBeenCalledOnce();
  });

  it("serializes concurrent consolidation writes", async () => {
    const releases: Array<() => void> = [];
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            releases.push(() =>
              resolve(
                `<facts><fact confidence="0.9">Shared semantic fact</fact></facts>`,
              ),
            );
          }),
      ),
    };
    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      provider as never,
    );
    for (let index = 0; index < 5; index++) {
      await kv.set("mem:summaries", `ses_${index}`, makeSummary(index));
    }

    const first = sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    });
    await Promise.resolve();
    expect(releases).toHaveLength(1);

    releases[0]();
    await first;
    const secondResult = (await second) as {
      results: { semantic: { skipped?: boolean; reason?: string } };
    };

    expect(await kv.list<SemanticMemory>("mem:semantic")).toHaveLength(1);
    expect(provider.summarize).toHaveBeenCalledOnce();
    expect(secondResult.results.semantic).toEqual({
      skipped: true,
      reason: "summaries unchanged",
    });
  });

  it("reruns semantic consolidation when forced with unchanged summaries", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi
        .fn()
        .mockResolvedValue(
          '<facts><fact confidence="0.9">Stable fact</fact></facts>',
        ),
    };
    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      provider as never,
    );
    for (let index = 0; index < 5; index++) {
      await kv.set("mem:summaries", `ses_${index}`, makeSummary(index));
    }

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });
    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      force: true,
    });

    expect(provider.summarize).toHaveBeenCalledTimes(2);
  });

  it("consolidates only summaries and semantic facts from the requested project", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<facts><fact confidence="0.9">Shared project fact</fact></facts>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (const project of ["proj-a", "proj-b"]) {
      for (let index = 0; index < 5; index++) {
        const sessionId = `${project}-ses-${index}`;
        await kv.set("mem:summaries", sessionId, {
          ...makeSummary(index),
          sessionId,
          project,
          narrative: `${project} narrative ${index}`,
        });
      }
    }
    const now = "2026-01-01T00:00:00Z";
    await kv.set("mem:semantic", "sem_b", {
      id: "sem_b",
      fact: "Shared project fact",
      confidence: 0.7,
      sourceSessionIds: ["proj-b-ses-0"],
      sourceMemoryIds: [],
      accessCount: 1,
      lastAccessedAt: now,
      strength: 0.7,
      createdAt: now,
      updatedAt: now,
    } satisfies SemanticMemory);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "proj-a",
    })) as { results: { semantic: { newFacts: number; totalSummaries: number } } };

    const prompt = String(provider.summarize.mock.calls[0]?.[1] ?? "");
    expect(prompt).toContain("proj-a narrative");
    expect(prompt).not.toContain("proj-b narrative");
    expect(result.results.semantic).toEqual({ newFacts: 1, totalSummaries: 5 });
    const semantic = await kv.list<SemanticMemory>("mem:semantic");
    expect(semantic).toHaveLength(2);
    expect(semantic.find((item) => item.id === "sem_b")!.accessCount).toBe(1);
    expect(semantic.find((item) => item.id !== "sem_b")!.sourceSessionIds)
      .toEqual(expect.arrayContaining(["proj-a-ses-0", "proj-a-ses-4"]));
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

  it("extracts procedures only from pattern memories in the requested project", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Shared Workflow" trigger="when needed"><step>Run project flow</step></procedure></procedures>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (const project of ["proj-a", "proj-b"]) {
      for (let index = 0; index < 2; index++) {
        const id = `${project}-mem-${index}`;
        await kv.set("mem:memories", id, {
          ...makePattern(index),
          id,
          project,
          content: `${project} pattern ${index}`,
          sessionIds: [`${project}-ses-1`, `${project}-ses-2`],
        });
      }
    }
    const now = "2026-01-01T00:00:00Z";
    await kv.set("mem:procedural", "proc_b", {
      id: "proc_b",
      name: "Shared Workflow",
      steps: ["Old B flow"],
      triggerCondition: "when needed",
      frequency: 3,
      sourceSessionIds: ["proj-b-ses-1"],
      strength: 0.5,
      createdAt: now,
      updatedAt: now,
    } satisfies ProceduralMemory);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
      project: "proj-a",
    })) as { results: { procedural: { newProcedures: number; patternsAnalyzed: number } } };

    const prompt = String(provider.summarize.mock.calls[0]?.[1] ?? "");
    expect(prompt).toContain("proj-a pattern");
    expect(prompt).not.toContain("proj-b pattern");
    expect(result.results.procedural).toEqual({
      newProcedures: 1,
      patternsAnalyzed: 2,
    });
    const procedural = await kv.list<ProceduralMemory>("mem:procedural");
    expect(procedural).toHaveLength(2);
    expect(procedural.find((item) => item.id === "proc_b")!.frequency).toBe(3);
    expect(procedural.find((item) => item.id !== "proc_b")!.sourceSessionIds)
      .toEqual(["proj-a-ses-1", "proj-a-ses-2"]);
  });

  it("decays only semantic and procedural records linked to the requested project", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (const project of ["proj-a", "proj-b"]) {
      const sessionId = `${project}-ses`;
      await kv.set("mem:summaries", sessionId, {
        ...makeSummary(1),
        sessionId,
        project,
      });
      const old = "2020-01-01T00:00:00Z";
      await kv.set("mem:semantic", `sem_${project}`, {
        id: `sem_${project}`,
        fact: `${project} fact`,
        confidence: 0.8,
        sourceSessionIds: [sessionId],
        sourceMemoryIds: [],
        accessCount: 1,
        lastAccessedAt: old,
        strength: 1,
        createdAt: old,
        updatedAt: old,
      } satisfies SemanticMemory);
      await kv.set("mem:procedural", `proc_${project}`, {
        id: `proc_${project}`,
        name: `${project} procedure`,
        steps: ["Run"],
        triggerCondition: "always",
        frequency: 1,
        sourceSessionIds: [sessionId],
        strength: 1,
        createdAt: old,
        updatedAt: old,
      } satisfies ProceduralMemory);
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "decay",
      project: "proj-a",
    })) as { results: { decay: { semantic: number; procedural: number } } };

    expect(result.results.decay).toEqual({ semantic: 1, procedural: 1 });
    expect((await kv.get<SemanticMemory>("mem:semantic", "sem_proj-a"))!.strength).toBeLessThan(1);
    expect((await kv.get<SemanticMemory>("mem:semantic", "sem_proj-b"))!.strength).toBe(1);
    expect((await kv.get<ProceduralMemory>("mem:procedural", "proc_proj-a"))!.strength).toBeLessThan(1);
    expect((await kv.get<ProceduralMemory>("mem:procedural", "proc_proj-b"))!.strength).toBe(1);
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

  it("serializes the reflect watermark check and update for each project", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    let releaseReflect!: (value: unknown) => void;
    const reflectFn = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        releaseReflect = resolve;
      }),
    );
    sdk.registerFunction("mem::reflect", reflectFn);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const first = sdk.trigger("mem::consolidate-pipeline", {
      tier: "all",
      project: "proj-a",
    });
    await vi.waitFor(() => expect(reflectFn).toHaveBeenCalledOnce());
    const second = sdk.trigger("mem::consolidate-pipeline", {
      tier: "all",
      project: "proj-a",
    });
    await Promise.resolve();
    expect(reflectFn).toHaveBeenCalledOnce();
    releaseReflect({ success: true, fullPassComplete: true });

    const [firstResult, secondResult] = await Promise.all([first, second]) as Array<{
      results: { reflect: { skipped?: boolean } };
    }>;
    expect(firstResult.results.reflect.skipped).toBeUndefined();
    expect(secondResult.results.reflect.skipped).toBe(true);
    expect(reflectFn).toHaveBeenCalledOnce();
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

  it("reflect gate retries empty provider output without advancing cursor or watermark", async () => {
    const now = new Date().toISOString();
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi
        .fn()
        .mockResolvedValueOnce("<insights></insights>")
        .mockResolvedValueOnce(
          `<insights><insight confidence="0.8" title="Validate Boundaries">Validate inputs at trust boundaries using layered checks.</insight></insights>`,
        ),
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

    const first = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "all",
    })) as {
      results: { reflect: { success: boolean; fullPassComplete: boolean } };
    };

    const wm = await kv.get("mem:config", "reflect:last-success:global");
    expect(wm).toBeNull();
    expect(first.results.reflect.success).toBe(false);
    expect(first.results.reflect.fullPassComplete).toBe(false);
    expect(
      await kv.get<{ processedFps: string[] }>(
        "mem:config",
        "reflect:cursor:global",
      ),
    ).toMatchObject({ processedFps: [] });

    await sdk.trigger("mem::consolidate-pipeline", { tier: "all" });

    expect(provider.summarize).toHaveBeenCalledTimes(2);
    expect(
      await kv.get("mem:config", "reflect:last-success:global"),
    ).not.toBeNull();
  });

  // ── Kill-switch flags: INSIGHT_SYNTHESIS_ENABLED / PROCEDURAL_EXTRACTION_ENABLED ──

  it("BASELINE: reflect + procedural tiers run with force:true and no flag gating", async () => {
    // Pins current behavior. With both flags enabled (the default the mock
    // uses for legacy tests) the forced tier=all pipeline attempts reflect
    // and procedural. This documents the pre-kill-switch contract.
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Baseline Flow" trigger="when x"><step>do y</step></procedure></procedures>`,
      ),
    };
    const reflectFn = vi.fn().mockResolvedValue({ success: true, fullPassComplete: true });
    sdk.registerFunction("mem::reflect", reflectFn);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 3; i++) {
      await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "all",
      force: true,
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    // reflect tier ran (mem::reflect invoked, not flag-skipped)
    expect(reflectFn).toHaveBeenCalled();
    const reflect = result.results.reflect as { skipped?: boolean };
    expect(reflect.skipped).toBeUndefined();
    // procedural tier ran (provider.summarize invoked, produced a procedure)
    const procedural = result.results.procedural as { newProcedures?: number };
    expect(procedural.newProcedures).toBe(1);
  });

  it("reflect tier skips with explicit reason when INSIGHT_SYNTHESIS_ENABLED is off, even with force:true", async () => {
    vi.mocked(isInsightSynthesisEnabled).mockReturnValue(false);
    vi.mocked(isProceduralExtractionEnabled).mockReturnValue(true);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Flow" trigger="when x"><step>do y</step></procedure></procedures>`,
      ),
    };
    const reflectFn = vi.fn().mockResolvedValue({ success: true, fullPassComplete: true });
    sdk.registerFunction("mem::reflect", reflectFn);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 3; i++) {
      await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "all",
      force: true,
    })) as { success: boolean; results: Record<string, unknown> };

    // reflect tier is an explicit skip, NOT a reflect invocation
    expect(result.results.reflect).toEqual({
      skipped: true,
      reason: "INSIGHT_SYNTHESIS_ENABLED=false",
    });
    expect(reflectFn).not.toHaveBeenCalled();
    // the skip must NOT falsely advance the reflect watermark
    const wm = await kv.get("mem:config", "reflect:last-success:global");
    expect(wm).toBeNull();
    // procedural tier is independent of the insight flag and still runs
    const procedural = result.results.procedural as { newProcedures?: number };
    expect(procedural.newProcedures).toBe(1);
  });

  it("procedural tier skips with explicit reason when PROCEDURAL_EXTRACTION_ENABLED is off, even with force:true", async () => {
    vi.mocked(isProceduralExtractionEnabled).mockReturnValue(false);
    vi.mocked(isInsightSynthesisEnabled).mockReturnValue(true);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Flow" trigger="when x"><step>do y</step></procedure></procedures>`,
      ),
    };
    const reflectFn = vi.fn().mockResolvedValue({ success: true, fullPassComplete: true });
    sdk.registerFunction("mem::reflect", reflectFn);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 3; i++) {
      await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "all",
      force: true,
    })) as { success: boolean; results: Record<string, unknown> };

    // procedural tier is an explicit skip, provider never invoked for extraction
    expect(result.results.procedural).toEqual({
      skipped: true,
      reason: "PROCEDURAL_EXTRACTION_ENABLED=false",
    });
    expect(provider.summarize).not.toHaveBeenCalled();
    // reflect tier is independent of the procedural flag and still runs
    expect(reflectFn).toHaveBeenCalled();
    const reflect = result.results.reflect as { skipped?: boolean };
    expect(reflect.skipped).toBeUndefined();
  });
});
