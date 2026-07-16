import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type {
  Lesson,
  ProjectProfile,
  Session,
  SessionSummary,
  MemorySlot,
} from "../src/types.js";

declare const process: { env: Record<string, string | undefined> };
const env = process.env;

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
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
      if (!store.has(scope)) return [];
      return Array.from(store.get(scope)!.values()) as T[];
    },
  };
}

type ContextHandler = (data: {
  sessionId: string;
  project: string;
  budget?: number;
}) => Promise<{ context: string; blocks: number; tokens: number }>;

function wireContext(kv: ReturnType<typeof mockKV>, budget: number) {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: vi.fn((id: string, cb: ContextHandler) => {
      if (id === "mem::context") handler = cb;
    }),
  } as unknown as import("iii-sdk").ISdk;
  registerContextFunction(sdk, kv as never, budget);
  if (!handler) throw new Error("mem::context not registered");
  return async (data: Parameters<ContextHandler>[0]) => {
    await kv.set(KV.sessions, data.sessionId, {
      id: data.sessionId,
      project: data.project,
      cwd: data.project,
      startedAt: NOW,
      status: "active",
      observationCount: 0,
    });
    return handler(data);
  };
}

const PROJECT = "/tmp/proj";
const DAYS_AGO = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
const NOW = new Date().toISOString();

async function seedSlot(
  kv: ReturnType<typeof mockKV>,
  label: string,
  content: string,
  scope: "project" | "global" = "global",
) {
  const slot: MemorySlot = {
    label,
    content,
    description: "",
    sizeLimit: 20000,
    pinned: true,
    readOnly: false,
    scope,
    ...(scope === "project" ? { project: PROJECT } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  };
  const target = scope === "project" ? KV.slots : KV.globalSlots;
  const key = scope === "project" ? `${PROJECT}:${label}` : label;
  await kv.set(target, key, slot);
}

async function seedLesson(
  kv: ReturnType<typeof mockKV>,
  partial: Partial<Lesson>,
) {
  const lesson: Lesson = {
    id: partial.id ?? `lesson_${Math.random().toString(36).slice(2)}`,
    content: partial.content ?? "x",
    context: partial.context ?? "",
    confidence: partial.confidence ?? 0.7,
    reinforcements: partial.reinforcements ?? 1,
    source: partial.source ?? "manual",
    sourceIds: partial.sourceIds ?? [],
    project: partial.project,
    tags: partial.tags ?? [],
    createdAt: partial.createdAt ?? DAYS_AGO,
    updatedAt: partial.updatedAt ?? DAYS_AGO,
    lastReinforcedAt: partial.lastReinforcedAt,
    lastDecayedAt: partial.lastDecayedAt,
    decayRate: partial.decayRate ?? 0.05,
    deleted: partial.deleted,
  };
  await kv.set(KV.lessons, lesson.id, lesson);
}

async function seedSessionWithSummary(
  kv: ReturnType<typeof mockKV>,
  id: string,
  narrativeLen: number,
) {
  const session: Session = {
    id,
    project: PROJECT,
    cwd: PROJECT,
    startedAt: NOW,
    status: "completed",
    observationCount: 3,
  };
  await kv.set(KV.sessions, id, session);
  const summary: SessionSummary = {
    sessionId: id,
    project: PROJECT,
    createdAt: NOW,
    title: `Session ${id}`,
    narrative: "n".repeat(narrativeLen),
    keyDecisions: ["decided x"],
    filesModified: ["a.ts"],
    concepts: ["c"],
    observationCount: 3,
  };
  await kv.set(KV.summaries, id, summary);
}

describe("mem::context lessons survive the deployed token budget", () => {
  const ORIGINAL_SLOTS_ENV = env["AGENTMEMORY_SLOTS"];

  beforeEach(() => {
    env["AGENTMEMORY_SLOTS"] = "true";
  });

  afterEach(() => {
    if (ORIGINAL_SLOTS_ENV === undefined) {
      delete env["AGENTMEMORY_SLOTS"];
    } else {
      env["AGENTMEMORY_SLOTS"] = ORIGINAL_SLOTS_ENV;
    }
  });

  it("injects lessons ahead of today's transient session summaries at budget=5000", async () => {
    const kv = mockKV();
    const handler = wireContext(kv, 5000);

    await seedSlot(kv, "tool_guidelines", "SLOT-GUIDE " + "g".repeat(2400));
    await seedSlot(kv, "project_context", "SLOT-CTX " + "p".repeat(2400), "project");

    for (let i = 0; i < 4; i++) {
      await seedLesson(kv, {
        id: `lesson_${i}`,
        content: `LESSON-MARKER-${i} ` + "l".repeat(880),
        project: PROJECT,
        confidence: 0.9 - i * 0.05,
      });
    }

    for (let i = 0; i < 5; i++) {
      await seedSessionWithSummary(kv, `ses_today_${i}`, 1800);
    }

    const result = await handler({ sessionId: "ses_current", project: PROJECT });

    expect(result.context).toContain("SLOT-GUIDE");
    expect(result.context).toContain("Lessons Learned");
    expect(result.context).toContain("LESSON-MARKER-0");
  });

  it("trims an oversized lessons corpus to fit rather than dropping it wholesale at budget=5000", async () => {
    const kv = mockKV();
    const handler = wireContext(kv, 5000);

    await seedSlot(kv, "tool_guidelines", "SLOT-GUIDE " + "g".repeat(2400));
    await seedSlot(kv, "project_context", "SLOT-CTX " + "p".repeat(2400), "project");

    for (let i = 0; i < 10; i++) {
      await seedLesson(kv, {
        id: `huge_${i}`,
        content: `HUGE-LESSON-${i} ` + "h".repeat(2300),
        project: PROJECT,
        confidence: 0.95 - i * 0.05,
      });
    }

    const result = await handler({ sessionId: "ses_current", project: PROJECT });

    expect(result.context).toContain("SLOT-GUIDE");
    expect(result.context).toContain("Lessons Learned");
    expect(result.context).toContain("HUGE-LESSON-0");
    const matched = result.context.match(/HUGE-LESSON-/g) ?? [];
    expect(matched.length).toBeLessThan(10);
    expect(matched.length).toBeGreaterThan(0);
    expect(result.tokens).toBeLessThanOrEqual(5000);
  });

  it("packs small slots, profile, and lessons when an oversized slot cannot fit", async () => {
    const kv = mockKV();
    const handler = wireContext(kv, 2000);

    await seedSlot(kv, "oversized", "OVERSIZED-SLOT " + "o".repeat(7000));
    await seedSlot(kv, "small_a", "SMALL-SLOT-A");
    await seedSlot(kv, "small_b", "SMALL-SLOT-B");
    await kv.set(KV.profiles, PROJECT, {
      project: PROJECT,
      topConcepts: [{ concept: "PROFILE-MARKER", frequency: 3 }],
      topFiles: [],
      conventions: [],
      commonErrors: [],
      recentActivity: [],
      sessionCount: 0,
      totalObservations: 0,
      updatedAt: NOW,
    } satisfies ProjectProfile);
    await seedLesson(kv, {
      id: "budget-lesson",
      content: "BUDGET-LESSON-MARKER " + "l".repeat(300),
      project: PROJECT,
      confidence: 0.9,
    });

    const result = await handler({
      sessionId: "ses_current",
      project: PROJECT,
    });

    expect(result.context).not.toContain("OVERSIZED-SLOT");
    expect(result.context).toContain("SMALL-SLOT-A");
    expect(result.context).toContain("SMALL-SLOT-B");
    expect(result.context).toContain("PROFILE-MARKER");
    expect(result.context).toContain("Lessons Learned");
    expect(result.context).toContain("BUDGET-LESSON-MARKER");
    expect(result.tokens).toBeLessThanOrEqual(2000);
  });
});
