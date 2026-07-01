import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  readMaxSingleCallMs,
  readReflectTimeoutMs,
  registerReflectFunctions,
} from "../src/functions/reflect.js";
import type { Insight, GraphNode, GraphEdge, SemanticMemory, Lesson } from "../src/types.js";
import { fingerprintId } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      const explicit = store.get(scope)?.get(key);
      if (explicit !== undefined) return explicit as T;
      // Mirror production: reflect reads the graph via readGraphSnapshot
      // (a kv.get on mem:graph:snapshot), which graph-extract maintains as a
      // top-degree view of the graph scopes. Tests seed mem:graph:nodes /
      // mem:graph:edges, so synthesize that snapshot on read instead of
      // forcing every test to seed it explicitly.
      if (scope === "mem:graph:snapshot" && key === "current") {
        const nodes = Array.from(
          store.get("mem:graph:nodes")?.values() ?? [],
        ) as GraphNode[];
        const edges = Array.from(
          store.get("mem:graph:edges")?.values() ?? [],
        ) as GraphEdge[];
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
          updatedAt: "2026-04-01T00:00:00Z",
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

function makeConceptNode(name: string): GraphNode {
  return {
    id: `node_${name}`,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

function makeEdge(src: string, tgt: string): GraphEdge {
  return {
    id: `edge_${src}_${tgt}`,
    type: "related_to",
    sourceNodeId: `node_${src}`,
    targetNodeId: `node_${tgt}`,
    weight: 1,
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

function makeSemantic(fact: string, id?: string): SemanticMemory {
  return {
    id: id || `sem_${fact.slice(0, 8)}`,
    fact,
    confidence: 0.8,
    sourceSessionIds: [],
    sourceMemoryIds: [],
    accessCount: 1,
    lastAccessedAt: "2026-04-01T00:00:00Z",
    strength: 0.8,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
  };
}

function makeLesson(content: string, tags: string[]): Lesson {
  return {
    id: `lsn_${content.slice(0, 8)}`,
    content,
    context: "",
    confidence: 0.7,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    tags,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    decayRate: 0.05,
  };
}

type ReflectCursorState = { processedFps: string[]; updatedAt: string };

function reflectCursorFp(concepts: string[], project?: string): string {
  return fingerprintId(
    "reflectcursor",
    `${project ?? ""}\n${concepts.map((c) => c.toLowerCase()).slice().sort().join(",")}`,
  );
}

const XML_RESPONSE = `<insights>
<insight confidence="0.85" title="Defense in Depth">
Security requires layered protection: input validation, safe APIs, and deny-lists together.
</insight>
<insight confidence="0.7" title="Testing at Boundaries">
Focus test effort on system boundaries where trust transitions occur.
</insight>
</insights>`;

describe("Reflect", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let provider: { name: string; compress: ReturnType<typeof vi.fn>; summarize: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(XML_RESPONSE),
    };
    registerReflectFunctions(sdk as never, kv as never, provider as never);
  });

  describe("mem::reflect", () => {
    it("returns empty when no graph nodes or memories exist", async () => {
      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
        clustersProcessed: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(0);
      expect(result.clustersProcessed).toBe(0);
    });

    it("synthesizes insights from graph concept clusters", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:nodes", "node_testing", makeConceptNode("testing"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:graph:edges", "edge_2", makeEdge("security", "testing"));

      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection attacks"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(2);
      expect(provider.summarize).toHaveBeenCalled();

      const insights = await kv.list<Insight>("mem:insights");
      expect(insights.length).toBe(2);
      expect(insights[0].title).toBeTruthy();
      expect(insights[0].sourceConceptCluster.length).toBeGreaterThan(0);
    });

    it("skips clusters with fewer than 3 supporting items", async () => {
      await kv.set("mem:graph:nodes", "node_sparse", makeConceptNode("sparse"));
      await kv.set("mem:graph:nodes", "node_topic", makeConceptNode("topic"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("sparse", "topic"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("One sparse fact"));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        clustersSkipped: number;
        newInsights: number;
      };

      expect(result.clustersSkipped).toBe(1);
      expect(result.newInsights).toBe(0);
      expect(provider.summarize).not.toHaveBeenCalled();
    });

    it("deduplicates insights by fingerprint", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));

      await sdk.trigger("mem::reflect", {});
      const first = await kv.list<Insight>("mem:insights");
      expect(first.length).toBe(2);

      const result = (await sdk.trigger("mem::reflect", {})) as {
        reinforced: number;
        newInsights: number;
      };

      expect(result.reinforced).toBe(2);
      expect(result.newInsights).toBe(0);

      const after = await kv.list<Insight>("mem:insights");
      expect(after.length).toBe(2);
      expect(after[0].reinforcements).toBe(1);
    });

    it("reinforces a near-duplicate insight instead of inserting a new one", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));

      const respA = `<insights><insight confidence="0.9" title="Defense in Depth">Security requires layered protection across input validation and safe deny lists together.</insight></insights>`;
      const respB = `<insights><insight confidence="0.9" title="Defense in Depth">Security requires layered protection across input validation and safe deny lists working together.</insight></insights>`;
      provider.summarize.mockReset();
      provider.summarize.mockResolvedValueOnce(respA).mockResolvedValueOnce(respB);

      await sdk.trigger("mem::reflect", {});
      const first = await kv.list<Insight>("mem:insights");
      expect(first.length).toBe(1);

      const result = (await sdk.trigger("mem::reflect", {})) as {
        reinforced: number;
        newInsights: number;
      };

      expect(result.reinforced).toBe(1);
      expect(result.newInsights).toBe(0);

      const after = await kv.list<Insight>("mem:insights");
      expect(after.length).toBe(1);
      expect(after[0].reinforcements).toBe(1);
    });

    it("unions new-cluster provenance when reinforcing a near-duplicate", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs", "sem_1"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage", "sem_2"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection", "sem_3"));

      const respA = `<insights><insight confidence="0.8" title="Layered defense protects systems against threats">Use multiple independent layers so a single failure never compromises the whole system together.</insight></insights>`;
      const respB = `<insights><insight confidence="0.8" title="Layered defense protects systems against threats">Use multiple independent layers so one single failure never compromises the whole system together.</insight></insights>`;
      provider.summarize.mockReset();
      provider.summarize.mockResolvedValueOnce(respA).mockResolvedValueOnce(respB);

      await sdk.trigger("mem::reflect", {});
      await kv.set("mem:semantic", "sem_4", makeSemantic("Security layering matters here", "sem_4"));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        reinforced: number;
        newInsights: number;
      };
      expect(result.reinforced).toBe(1);
      expect(result.newInsights).toBe(0);

      const insights = await kv.list<Insight>("mem:insights");
      expect(insights.length).toBe(1);
      expect(insights[0].sourceMemoryIds).toContain("sem_1");
      expect(insights[0].sourceMemoryIds).toContain("sem_4");
      expect(insights[0].reinforcements).toBe(1);
    });

    it("keeps byte-identical insights in different projects separate", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));

      await sdk.trigger("mem::reflect", { project: "proj-a" });
      await sdk.trigger("mem::reflect", { project: "proj-b" });

      const insights = await kv.list<Insight>("mem:insights");
      expect(insights.length).toBe(4);
      expect(insights.filter((i) => i.project === "proj-a").length).toBe(2);
      expect(insights.filter((i) => i.project === "proj-b").length).toBe(2);
    });

    it("reinforces an existing insight at most once per reflect run", async () => {
      const ts = new Date().toISOString();
      await kv.set("mem:insights", "ins_E", {
        id: "ins_E",
        title: "Layered defense protects the whole system",
        content: "Apply multiple independent layers so a single failure never compromises the entire system overall",
        confidence: 0.8, reinforcements: 0, sourceConceptCluster: ["security"],
        sourceMemoryIds: [], sourceLessonIds: [], sourceCrystalIds: [],
        tags: ["security"], createdAt: ts, updatedAt: ts, decayRate: 0.05,
      });
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));

      const twoNearDups = `<insights><insight confidence="0.8" title="Layered defense protects the whole system">Apply multiple independent layers so a single failure never compromises the entire system overall today.</insight><insight confidence="0.8" title="Layered defense protects the whole system">Apply multiple independent layers so a single failure never compromises the entire system overall now.</insight></insights>`;
      provider.summarize.mockReset();
      provider.summarize.mockResolvedValue(twoNearDups);

      await sdk.trigger("mem::reflect", {});

      const after = await kv.get<Insight>("mem:insights", "ins_E");
      expect(after!.reinforcements).toBe(1);
    });

    it("falls back to Jaccard grouping when graph is empty", async () => {
      await kv.set("mem:semantic", "sem_1", makeSemantic("security validation is important"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("security testing prevents bugs"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("validation testing framework"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use security headers", ["security", "validation"]));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        usedFallback: boolean;
      };

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });

    it("handles LLM failure gracefully", async () => {
      provider.summarize.mockRejectedValue(new Error("LLM timeout"));

      await kv.set("mem:graph:nodes", "node_a", makeConceptNode("concept_a"));
      await kv.set("mem:graph:nodes", "node_b", makeConceptNode("concept_b"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("concept_a", "concept_b"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("fact about concept_a"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("fact about concept_b"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("concept_a and concept_b together"));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
      };

      expect(result.success).toBe(false);
      expect(result.newInsights).toBe(0);
    });

    it("reinforces a legacy content-only-keyed insight instead of inserting after the key scheme change", async () => {
      const content = "Caching reduces latency by storing computed results close to the consumer for fast reuse";
      const legacyFp = fingerprintId("ins", content.trim().toLowerCase());
      const ts = new Date().toISOString();
      await kv.set("mem:insights", legacyFp, {
        id: legacyFp,
        title: "Old caching note from a previous title scheme",
        content,
        confidence: 0.8, reinforcements: 0, sourceConceptCluster: ["security"],
        sourceMemoryIds: [], sourceLessonIds: [], sourceCrystalIds: [],
        tags: ["security"], createdAt: ts, updatedAt: ts, decayRate: 0.05,
      });
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));

      const resp = `<insights><insight confidence="0.8" title="Completely different heading with no shared words">${content}</insight></insights>`;
      provider.summarize.mockReset();
      provider.summarize.mockResolvedValue(resp);

      const result = (await sdk.trigger("mem::reflect", {})) as {
        reinforced: number;
        newInsights: number;
      };

      expect(result.newInsights).toBe(0);
      expect(result.reinforced).toBe(1);
      const insights = await kv.list<Insight>("mem:insights");
      expect(insights.length).toBe(1);
      expect(insights[0].reinforcements).toBe(1);
    });

    it("freezes a lesson-bearing cluster on the second run when lessonIds are unchanged", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));

      await sdk.trigger("mem::reflect", {});
      const first = await kv.list<Insight>("mem:insights");
      expect(first.length).toBe(2);

      provider.summarize.mockClear();
      const result = (await sdk.trigger("mem::reflect", {})) as {
        clustersFrozen: number;
        newInsights: number;
        reinforced: number;
      };

      expect(provider.summarize).not.toHaveBeenCalled();
      expect(result.clustersFrozen).toBe(1);
      expect(result.newInsights).toBe(0);
      expect(result.reinforced).toBe(0);
    });

    it("stamps reflectClusterFp and version on insights from a lesson-bearing cluster", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));

      await sdk.trigger("mem::reflect", {});

      const insights = await kv.list<Insight>("mem:insights");
      expect(insights.length).toBe(2);
      for (const ins of insights) {
        expect(ins.reflectClusterFp).toBeTruthy();
        expect(ins.reflectClusterFpVersion).toBe(1);
      }
    });

    it("leaves reflectClusterFp undefined on insights from a lesson-less cluster", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));

      await sdk.trigger("mem::reflect", {});

      const insights = await kv.list<Insight>("mem:insights");
      expect(insights.length).toBe(2);
      for (const ins of insights) {
        expect(ins.reflectClusterFp).toBeUndefined();
      }
    });

    it("reprocesses a lesson-bearing cluster when a new lesson changes the lessonIds between runs", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));

      await sdk.trigger("mem::reflect", {});
      const firstFp = (await kv.list<Insight>("mem:insights"))[0].reflectClusterFp;
      expect(firstFp).toBeTruthy();

      await kv.set("mem:lessons", "lsn_2", makeLesson("Validate inputs at trust boundaries", ["security"]));

      provider.summarize.mockClear();
      const result = (await sdk.trigger("mem::reflect", {})) as {
        clustersFrozen: number;
      };

      expect(provider.summarize).toHaveBeenCalled();
      expect(result.clustersFrozen).toBe(0);
      const after = await kv.list<Insight>("mem:insights");
      expect(after[0].reflectClusterFp).not.toBe(firstFp);
    });

    it("never freezes a lesson-bearing cluster when the provider yields no insights", async () => {
      provider.summarize.mockReset();
      provider.summarize.mockResolvedValue("");

      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));

      const run1 = (await sdk.trigger("mem::reflect", {})) as {
        newInsights: number;
        clustersFrozen: number;
      };
      expect(run1.newInsights).toBe(0);
      expect(run1.clustersFrozen).toBe(0);

      const run2 = (await sdk.trigger("mem::reflect", {})) as {
        clustersFrozen: number;
      };
      expect(provider.summarize).toHaveBeenCalledTimes(2);
      expect(run2.clustersFrozen).toBe(0);
    });

    it("backfills reflectClusterFp on a pre-existing insight and freezes the matching cluster in the same run", async () => {
      const ts = new Date().toISOString();
      const lessonId = `lsn_${"Use execFile for security".slice(0, 8)}`;
      await kv.set("mem:insights", "ins_pre", {
        id: "ins_pre",
        title: "Pre-existing note from before the fingerprint feature",
        content: "Prior synthesized guidance about defense layering for systems",
        confidence: 0.8, reinforcements: 0, sourceConceptCluster: ["security"],
        sourceMemoryIds: [], sourceLessonIds: [lessonId], sourceCrystalIds: [],
        tags: ["security"], createdAt: ts, updatedAt: ts, decayRate: 0.05,
      });
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));

      provider.summarize.mockClear();
      const result = (await sdk.trigger("mem::reflect", {})) as {
        clustersFrozen: number;
        newInsights: number;
      };

      expect(provider.summarize).not.toHaveBeenCalled();
      expect(result.clustersFrozen).toBe(1);
      expect(result.newInsights).toBe(0);
      const after = await kv.get<Insight>("mem:insights", "ins_pre");
      expect(after!.reflectClusterFp).toBeTruthy();
      expect(after!.reflectClusterFpVersion).toBe(1);
    });

    it("reports failure when every non-frozen cluster's provider call fails even though another cluster froze", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_alpha", makeConceptNode("alpha"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:nodes", "node_beta", makeConceptNode("beta"));
      await kv.set("mem:graph:edges", "edge_sv", makeEdge("security", "validation"));
      await kv.set("mem:graph:edges", "edge_ab", makeEdge("alpha", "beta"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));
      await kv.set("mem:semantic", "sem_4", makeSemantic("alpha foundation matters", "sem_4"));
      await kv.set("mem:semantic", "sem_5", makeSemantic("beta extends alpha", "sem_5"));
      await kv.set("mem:semantic", "sem_6", makeSemantic("alpha beta integration", "sem_6"));

      await sdk.trigger("mem::reflect", {});

      provider.summarize.mockReset();
      provider.summarize.mockRejectedValue(new Error("LLM down"));
      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        clustersFrozen: number;
      };

      expect(result.clustersFrozen).toBe(1);
      expect(result.success).toBe(false);
    });

    it("does not crash when a pre-existing insight is missing sourceLessonIds", async () => {
      const ts = new Date().toISOString();
      await kv.set("mem:insights", "ins_legacy", {
        id: "ins_legacy",
        title: "Legacy insight from before the provenance fields existed",
        content: "Old guidance with no source arrays",
        confidence: 0.8, reinforcements: 0, sourceConceptCluster: ["security"],
        sourceMemoryIds: [], sourceCrystalIds: [],
        tags: ["security"], createdAt: ts, updatedAt: ts, decayRate: 0.05,
      } as never);
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));

      const result = (await sdk.trigger("mem::reflect", {})) as { success: boolean };
      expect(result.success).toBe(true);
    });
  });

  describe("mem::insight-list", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      await kv.set("mem:insights", "ins_1", {
        id: "ins_1", title: "Insight A", content: "Content A", confidence: 0.9,
        reinforcements: 2, sourceConceptCluster: ["security"], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], project: "/app",
        tags: ["security"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
      await kv.set("mem:insights", "ins_2", {
        id: "ins_2", title: "Insight B", content: "Content B", confidence: 0.4,
        reinforcements: 0, sourceConceptCluster: ["testing"], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], project: "/other",
        tags: ["testing"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
    });

    it("lists all non-deleted insights sorted by confidence", async () => {
      const result = (await sdk.trigger("mem::insight-list", {})) as { insights: Insight[] };
      expect(result.insights.length).toBe(2);
      expect(result.insights[0].confidence).toBe(0.9);
    });

    it("filters by project", async () => {
      const result = (await sdk.trigger("mem::insight-list", { project: "/app" })) as { insights: Insight[] };
      expect(result.insights.length).toBe(1);
    });

    it("filters by minConfidence", async () => {
      const result = (await sdk.trigger("mem::insight-list", { minConfidence: 0.5 })) as { insights: Insight[] };
      expect(result.insights.length).toBe(1);
    });

    it("collapses near-duplicate insights by normalized title in the list", async () => {
      const now = new Date().toISOString();
      const base = {
        content: "Keep registries thin.", reinforcements: 0,
        sourceConceptCluster: [], sourceMemoryIds: [], sourceLessonIds: [],
        sourceCrystalIds: [], project: "/dup", tags: [], createdAt: now, updatedAt: now, decayRate: 0.05,
      };
      await kv.set("mem:insights", "dup_1", {
        ...base, id: "dup_1", title: "Prefer thin registries until consumers demand shape", confidence: 0.93,
      });
      await kv.set("mem:insights", "dup_2", {
        ...base, id: "dup_2", title: "Prefer Thin Registries Until Consumers Demand Shape", confidence: 0.91,
      });
      await kv.set("mem:insights", "dup_3", {
        ...base, id: "dup_3", title: "prefer thin registries, until consumers demand a shape.", confidence: 0.92,
      });

      const result = (await sdk.trigger("mem::insight-list", { project: "/dup" })) as { insights: Insight[] };
      expect(result.insights.length).toBe(1);
      expect(result.insights[0].confidence).toBe(0.93);
    });

    it("does not collapse same-title insights from different projects in the list", async () => {
      const now = new Date().toISOString();
      const base = {
        content: "c", reinforcements: 0, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [], createdAt: now, updatedAt: now, decayRate: 0.05,
      };
      await kv.set("mem:insights", "px", { ...base, id: "px", title: "Shared insight title across many projects", confidence: 0.9, project: "proj-x" });
      await kv.set("mem:insights", "py", { ...base, id: "py", title: "Shared insight title across many projects", confidence: 0.8, project: "proj-y" });

      const result = (await sdk.trigger("mem::insight-list", {})) as { insights: Insight[] };
      const shared = result.insights.filter((i) => i.title === "Shared insight title across many projects");
      expect(shared.length).toBe(2);
    });
  });

  describe("mem::insight-search", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      await kv.set("mem:insights", "ins_1", {
        id: "ins_1", title: "Defense in Depth", content: "Security requires layered protection",
        confidence: 0.85, reinforcements: 1, sourceConceptCluster: ["security"],
        sourceMemoryIds: [], sourceLessonIds: [], sourceCrystalIds: [],
        tags: ["security"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
    });

    it("finds insights matching query", async () => {
      const result = (await sdk.trigger("mem::insight-search", {
        query: "security layered protection",
      })) as { insights: Array<Insight & { score: number }> };

      expect(result.insights.length).toBe(1);
      expect(result.insights[0].title).toBe("Defense in Depth");
    });

    it("collapses near-duplicate insights in search results", async () => {
      const now = new Date().toISOString();
      const base = {
        content: "Keep registries thin until consumers need shape.", reinforcements: 0,
        sourceConceptCluster: [], sourceMemoryIds: [], sourceLessonIds: [],
        sourceCrystalIds: [], tags: [], createdAt: now, updatedAt: now, decayRate: 0.05,
      };
      await kv.set("mem:insights", "sdup_1", {
        ...base, id: "sdup_1", title: "Prefer thin registries until consumers demand shape", confidence: 0.93,
      });
      await kv.set("mem:insights", "sdup_2", {
        ...base, id: "sdup_2", title: "Prefer Thin Registries Until Consumers Demand Shape", confidence: 0.91,
      });
      await kv.set("mem:insights", "sdup_3", {
        ...base, id: "sdup_3", title: "prefer thin registries, until consumers demand a shape!", confidence: 0.92,
      });

      const result = (await sdk.trigger("mem::insight-search", {
        query: "thin registries shape",
      })) as { insights: Array<Insight & { score: number }> };

      const dupes = result.insights.filter((i) => i.title.toLowerCase().includes("registries"));
      expect(dupes.length).toBe(1);
    });

    it("does not collapse same-title insights from different projects in search", async () => {
      const now = new Date().toISOString();
      const base = {
        content: "registries thin shape", reinforcements: 0, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [], createdAt: now, updatedAt: now, decayRate: 0.05,
      };
      await kv.set("mem:insights", "qx", { ...base, id: "qx", title: "Registries should stay thin in shape", confidence: 0.9, project: "proj-x" });
      await kv.set("mem:insights", "qy", { ...base, id: "qy", title: "Registries should stay thin in shape", confidence: 0.8, project: "proj-y" });

      const result = (await sdk.trigger("mem::insight-search", { query: "registries thin shape" })) as { insights: Array<Insight & { score: number }> };
      const shared = result.insights.filter((i) => i.title === "Registries should stay thin in shape");
      expect(shared.length).toBe(2);
    });

    it("rejects empty query", async () => {
      const result = (await sdk.trigger("mem::insight-search", { query: "" })) as { success: boolean };
      expect(result.success).toBe(false);
    });
  });

  describe("mem::insight-decay-sweep", () => {
    it("decays old insights incrementally", async () => {
      await kv.set("mem:insights", "ins_old", {
        id: "ins_old", title: "Old", content: "Old insight", confidence: 0.8,
        reinforcements: 1, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        decayRate: 0.05,
      });

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { decayed: number };
      expect(result.decayed).toBe(1);

      const after = await kv.get<Insight>("mem:insights", "ins_old");
      expect(after!.confidence).toBeLessThan(0.8);
      expect(after!.lastDecayedAt).toBeDefined();
    });

    it("soft-deletes low-confidence unreinforced insights", async () => {
      await kv.set("mem:insights", "ins_weak", {
        id: "ins_weak", title: "Weak", content: "Weak insight", confidence: 0.12,
        reinforcements: 0, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        decayRate: 0.05,
      });

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { softDeleted: number };
      expect(result.softDeleted).toBe(1);

      const after = await kv.get<Insight>("mem:insights", "ins_weak");
      expect(after!.deleted).toBe(true);
    });
  });
});


describe("Reflect budget (AGENTMEMORY_REFLECT_TIMEOUT_MS)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let provider: { name: string; compress: ReturnType<typeof vi.fn>; summarize: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(XML_RESPONSE),
    };
    registerReflectFunctions(sdk as never, kv as never, provider as never);
  });

  async function seedOneCluster() {
    await kv.set("mem:graph:nodes", "node_a", makeConceptNode("concept_a"));
    await kv.set("mem:graph:nodes", "node_b", makeConceptNode("concept_b"));
    await kv.set("mem:graph:edges", "edge_1", makeEdge("concept_a", "concept_b"));
    await kv.set("mem:semantic", "sem_1", makeSemantic("fact about concept_a"));
    await kv.set("mem:semantic", "sem_2", makeSemantic("fact about concept_b"));
    await kv.set("mem:semantic", "sem_3", makeSemantic("concept_a and concept_b together"));
  }

  async function seedTwoProcessableClusters() {
    await kv.set("mem:graph:nodes", "node_alpha", makeConceptNode("alpha"));
    await kv.set("mem:graph:nodes", "node_beta", makeConceptNode("beta"));
    await kv.set("mem:graph:nodes", "node_alphaextra", makeConceptNode("alphaextra"));
    await kv.set("mem:graph:edges", "edge_ab", makeEdge("alpha", "beta"));
    await kv.set("mem:graph:edges", "edge_ae", makeEdge("alpha", "alphaextra"));
    await kv.set("mem:semantic", "sem_alpha_1", makeSemantic("alpha fact one", "sem_alpha_1"));
    await kv.set("mem:semantic", "sem_beta_1", makeSemantic("beta fact two", "sem_beta_1"));
    await kv.set("mem:semantic", "sem_alpha_beta", makeSemantic("alpha beta fact three", "sem_alpha_beta"));

    await kv.set("mem:graph:nodes", "node_gamma", makeConceptNode("gamma"));
    await kv.set("mem:graph:nodes", "node_delta", makeConceptNode("delta"));
    await kv.set("mem:graph:nodes", "node_gammaextra", makeConceptNode("gammaextra"));
    await kv.set("mem:graph:edges", "edge_gd", makeEdge("gamma", "delta"));
    await kv.set("mem:graph:edges", "edge_ge", makeEdge("gamma", "gammaextra"));
    await kv.set("mem:semantic", "sem_gamma_1", makeSemantic("gamma fact one", "sem_gamma_1"));
    await kv.set("mem:semantic", "sem_delta_1", makeSemantic("delta fact two", "sem_delta_1"));
    await kv.set("mem:semantic", "sem_gamma_delta", makeSemantic("gamma delta fact three", "sem_gamma_delta"));
  }

  async function seedFactsOnlyAndLessonCluster() {
    await kv.set("mem:graph:nodes", "node_factsonly", makeConceptNode("factsonly"));
    await kv.set("mem:graph:nodes", "node_evidence", makeConceptNode("evidence"));
    await kv.set("mem:graph:nodes", "node_archive", makeConceptNode("archive"));
    await kv.set("mem:graph:edges", "edge_fe", makeEdge("factsonly", "evidence"));
    await kv.set("mem:graph:edges", "edge_fa", makeEdge("factsonly", "archive"));
    await kv.set("mem:semantic", "sem_factsonly_1", makeSemantic("factsonly evidence one", "sem_factsonly_1"));
    await kv.set("mem:semantic", "sem_factsonly_2", makeSemantic("factsonly evidence two", "sem_factsonly_2"));
    await kv.set("mem:semantic", "sem_evidence_1", makeSemantic("evidence factsonly three", "sem_evidence_1"));

    await kv.set("mem:graph:nodes", "node_policy", makeConceptNode("policy"));
    await kv.set("mem:graph:nodes", "node_review", makeConceptNode("review"));
    await kv.set("mem:graph:nodes", "node_policyextra", makeConceptNode("policyextra"));
    await kv.set("mem:graph:edges", "edge_pr", makeEdge("policy", "review"));
    await kv.set("mem:graph:edges", "edge_pe", makeEdge("policy", "policyextra"));
    await kv.set("mem:semantic", "sem_policy_1", makeSemantic("policy review one", "sem_policy_1"));
    await kv.set("mem:semantic", "sem_review_1", makeSemantic("review policy two", "sem_review_1"));
    await kv.set("mem:semantic", "sem_policy_review", makeSemantic("policy review three", "sem_policy_review"));
    await kv.set("mem:lessons", "lsn_policy", makeLesson("Policy review catches drift", ["policy"]));
  }

  it("keeps the implicit reflect budget under the iii invocation cap", () => {
    try {
      vi.stubEnv("AGENTMEMORY_REFLECT_TIMEOUT_MS", "");
      vi.stubEnv("OPENAI_TIMEOUT_MS", "");
      for (const llmTimeout of ["60000", "180000", "600000"]) {
        vi.stubEnv("AGENTMEMORY_LLM_TIMEOUT_MS", llmTimeout);

        expect(readReflectTimeoutMs() + readMaxSingleCallMs() + 60_000).toBeLessThanOrEqual(900_000);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("clamps an explicit reflect budget above the safe ceiling", () => {
    try {
      vi.stubEnv("AGENTMEMORY_LLM_TIMEOUT_MS", "600000");
      vi.stubEnv("AGENTMEMORY_REFLECT_TIMEOUT_MS", "600000");
      vi.stubEnv("OPENAI_TIMEOUT_MS", "");

      expect(readReflectTimeoutMs()).toBe(240_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the computed default budget when no timeout env vars are set", () => {
    try {
      vi.stubEnv("AGENTMEMORY_REFLECT_TIMEOUT_MS", "");
      vi.stubEnv("AGENTMEMORY_LLM_TIMEOUT_MS", "");
      vi.stubEnv("OPENAI_TIMEOUT_MS", "");

      expect(readReflectTimeoutMs()).toBe(780_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("normal run does not report budget exhaustion", async () => {
    await seedOneCluster();
    const result = (await sdk.trigger("mem::reflect", {})) as {
      success: boolean;
      budgetExhausted: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.budgetExhausted).toBe(false);
    expect(provider.summarize).toHaveBeenCalled();
  });

  it("exhausted budget returns partial success and skips remaining LLM calls", async () => {
    await seedOneCluster();
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(t0);
    nowSpy.mockReturnValue(t0 + 10_000_000);

    const result = (await sdk.trigger("mem::reflect", {})) as {
      success: boolean;
      budgetExhausted: boolean;
      newInsights: number;
    };
    nowSpy.mockRestore();

    expect(result.success).toBe(true);
    expect(result.budgetExhausted).toBe(true);
    expect(result.newInsights).toBe(0);
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("resumes from the cluster cursor and resets it after a full pass", async () => {
    await seedTwoProcessableClusters();
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_000;
    nowSpy.mockImplementation(() => now);
    provider.summarize.mockImplementation(async () => {
      now += 2;
      return XML_RESPONSE;
    });

    try {
      vi.stubEnv("AGENTMEMORY_REFLECT_TIMEOUT_MS", "1");
      vi.stubEnv("OPENAI_TIMEOUT_MS", "");

      const run1 = (await sdk.trigger("mem::reflect", {})) as {
        fullPassComplete: boolean;
        budgetExhausted: boolean;
      };
      const cursorAfterRun1 = await kv.get<ReflectCursorState>("mem:config", "reflect:cursor:global");

      expect(run1.fullPassComplete).toBe(false);
      expect(run1.budgetExhausted).toBe(true);
      expect(cursorAfterRun1?.processedFps).toEqual([reflectCursorFp(["alpha", "beta", "alphaextra"])]);
      expect(provider.summarize).toHaveBeenCalledTimes(1);

      now = 2_000;
      const run2 = (await sdk.trigger("mem::reflect", {})) as {
        fullPassComplete: boolean;
        budgetExhausted: boolean;
      };
      const cursorAfterRun2 = await kv.get<ReflectCursorState>("mem:config", "reflect:cursor:global");
      const secondPrompt = String(provider.summarize.mock.calls[1]?.[1] ?? "");

      expect(run2.fullPassComplete).toBe(true);
      expect(run2.budgetExhausted).toBe(false);
      expect(secondPrompt).toContain("gamma");
      expect(secondPrompt).not.toContain("alpha");
      expect(cursorAfterRun2?.processedFps).toEqual([]);
      expect(provider.summarize).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("does not reprocess facts-only clusters within a cursor pass", async () => {
    await seedFactsOnlyAndLessonCluster();
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_000;
    nowSpy.mockImplementation(() => now);
    provider.summarize.mockImplementation(async () => {
      now += 2;
      return XML_RESPONSE;
    });

    try {
      vi.stubEnv("AGENTMEMORY_REFLECT_TIMEOUT_MS", "1");
      vi.stubEnv("OPENAI_TIMEOUT_MS", "");

      const run1 = (await sdk.trigger("mem::reflect", {})) as { fullPassComplete: boolean };
      const cursorAfterRun1 = await kv.get<ReflectCursorState>("mem:config", "reflect:cursor:global");

      expect(run1.fullPassComplete).toBe(false);
      expect(cursorAfterRun1?.processedFps).toContain(reflectCursorFp(["factsonly", "evidence", "archive"]));

      now = 2_000;
      const run2 = (await sdk.trigger("mem::reflect", {})) as { fullPassComplete: boolean };
      const secondPrompt = String(provider.summarize.mock.calls[1]?.[1] ?? "");

      expect(run2.fullPassComplete).toBe(true);
      expect(secondPrompt).toContain("policy");
      expect(secondPrompt).not.toContain("factsonly");
      expect(provider.summarize).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
