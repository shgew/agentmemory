import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  Session,
  SessionSummary,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)?.set(key, data);
      return data;
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

type ContextResult = { context: string; blocks: number; tokens: number };
type ContextHandler = (data: {
  sessionId: string;
  project: string;
  budget?: number;
}) => Promise<ContextResult>;

function wireContext(kv: ReturnType<typeof mockKV>): ContextHandler {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: vi.fn((id: string, callback: ContextHandler) => {
      if (id === "mem::context") handler = callback;
    }),
  };
  registerContextFunction(sdk as never, kv as never, 4000);
  if (!handler) throw new Error("mem::context not registered");
  return handler;
}

function session(overrides: Partial<Session>): Session {
  return {
    id: "session",
    project: "/tmp/project",
    cwd: "/tmp/project",
    startedAt: "2026-07-15T10:00:00.000Z",
    status: "active",
    observationCount: 0,
    ...overrides,
  };
}

function observation(sessionId: string): CompressedObservation {
  return {
    id: `${sessionId}-observation`,
    sessionId,
    timestamp: "2026-07-15T10:05:00.000Z",
    sourceType: "post_tool_use",
    type: "discovery",
    title: "raw-child-observation-marker",
    facts: [],
    narrative: "raw child narrative must not enter parent context",
    concepts: [],
    files: ["src/raw-child.ts"],
    importance: 10,
  };
}

describe("mem::context subagent rollup", () => {
  let kv: ReturnType<typeof mockKV>;
  let handler: ContextHandler;

  beforeEach(() => {
    kv = mockKV();
    handler = wireContext(kv);
  });

  it("packs one synthetic rollup from child summaries and metadata without raw child observations", async () => {
    const parent = session({ id: "parent-session" });
    const summarizedChild = session({
      id: "child-summarized",
      parentSessionId: parent.id,
      observationCount: 3,
      summary: "summary metadata label",
    });
    const pendingChild = session({
      id: "child-pending",
      parentSessionId: parent.id,
      observationCount: 2,
      summary: "Explore cache",
    });
    const childSummary: SessionSummary = {
      sessionId: summarizedChild.id,
      project: parent.project,
      createdAt: "2026-07-15T10:10:00.000Z",
      title: "Investigate auth",
      narrative: "Auth findings",
      keyDecisions: [],
      filesModified: ["src/auth.ts"],
      concepts: ["auth"],
      observationCount: 3,
    };
    await kv.set(KV.sessions, parent.id, parent);
    await kv.set(KV.sessions, summarizedChild.id, summarizedChild);
    await kv.set(KV.sessions, pendingChild.id, pendingChild);
    await kv.set(KV.summaries, summarizedChild.id, childSummary);
    await kv.set(
      KV.observations(pendingChild.id),
      "raw-child-observation",
      observation(pendingChild.id),
    );

    const result = await handler({
      sessionId: parent.id,
      project: parent.project,
    });

    expect(result.context.match(/<subagent-activity-summary\b/g)).toHaveLength(1);
    expect(result.context).toMatch(/task-count="2"/);
    expect(result.context).toMatch(/observation-count="5"/);
    expect(result.context).toContain("Investigate auth");
    expect(result.context).toContain("Explore cache");
    expect(result.context).toContain("src/auth.ts");
    expect(result.context).not.toContain("raw-child-observation-marker");
    expect(result.blocks).toBe(1);
  });

  it("ignores an orphan child whose claimed parent session does not exist", async () => {
    const orphan = session({
      id: "orphan-child",
      parentSessionId: "deleted-parent",
      observationCount: 1,
      summary: "orphan task",
    });
    await kv.set(KV.sessions, orphan.id, orphan);
    await kv.set(
      KV.observations(orphan.id),
      "orphan-observation",
      observation(orphan.id),
    );

    const result = await handler({
      sessionId: "deleted-parent",
      project: orphan.project,
    });

    expect(result.context).toBe("");
    expect(result.blocks).toBe(0);
  });
});
