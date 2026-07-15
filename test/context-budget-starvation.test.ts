import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type {
  Lesson,
  Session,
  SessionSummary,
  MemorySlot,
} from "../src/types.js";

// Regression coverage for the deployed-budget lessons starvation:
// at TOKEN_BUDGET=5000 the whole "## Lessons Learned" block was dropped
// because (a) its recency (days-old) sorted it behind today's pinned
// slots + session summaries and (b) the monolithic 10-lesson block was
// too large to ever fit alongside the load-bearing slots.

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
  return handler;
}

const PROJECT = "/tmp/proj";
const DAYS_AGO = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
const NOW = new Date().toISOString();

async function seedSlot(
  kv: ReturnType<typeof mockKV>,
  label: string,
  content: string,
) {
  const slot: MemorySlot = {
    label,
    content,
    description: "",
    sizeLimit: 20000,
    pinned: true,
    readOnly: false,
    scope: "global",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await kv.set(KV.globalSlots, label, slot);
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

describe("mem::context — lessons survive the deployed token budget", () => {
  const ORIGINAL_SLOTS_ENV = process.env["AGENTMEMORY_SLOTS"];

  beforeEach(() => {
    process.env["AGENTMEMORY_SLOTS"] = "true";
  });

  afterEach(() => {
    if (ORIGINAL_SLOTS_ENV === undefined) {
      delete process.env["AGENTMEMORY_SLOTS"];
    } else {
      process.env["AGENTMEMORY_SLOTS"] = ORIGINAL_SLOTS_ENV;
    }
  });

  it("injects lessons ahead of today's transient session summaries at budget=5000", async () => {
    const kv = mockKV();
    const handler = wireContext(kv, 5000);

    // Load-bearing pinned slots (~1.6k tokens) must stay first.
    await seedSlot(kv, "tool_guidelines", "SLOT-GUIDE " + "g".repeat(2400));
    await seedSlot(kv, "project_context", "SLOT-CTX " + "p".repeat(2400));

    // Days-old lessons — the block sorts behind everything from today.
    for (let i = 0; i < 4; i++) {
      await seedLesson(kv, {
        id: `lesson_${i}`,
        content: `LESSON-MARKER-${i} ` + "l".repeat(880),
        project: PROJECT,
        confidence: 0.9 - i * 0.05,
      });
    }

    // Several of today's sessions with fat summaries that greedily fill
    // the remaining budget before the days-old lessons block is reached.
    for (let i = 0; i < 5; i++) {
      await seedSessionWithSummary(kv, `ses_today_${i}`, 1800);
    }

    const result = await handler({ sessionId: "ses_current", project: PROJECT });

    // Slots must still be present (never displaced).
    expect(result.context).toContain("SLOT-GUIDE");
    // The lessons block must survive.
    expect(result.context).toContain("Lessons Learned");
    expect(result.context).toContain("LESSON-MARKER-0");
  });

  it("trims an oversized lessons corpus to fit rather than dropping it wholesale at budget=5000", async () => {
    const kv = mockKV();
    const handler = wireContext(kv, 5000);

    await seedSlot(kv, "tool_guidelines", "SLOT-GUIDE " + "g".repeat(2400));
    await seedSlot(kv, "project_context", "SLOT-CTX " + "p".repeat(2400));

    // 10 large lessons -> a monolithic block far bigger than the whole
    // budget. It must be trimmed to a reserved sub-budget, not skipped.
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
    // Highest-confidence lesson must be the one that survives the trim.
    expect(result.context).toContain("HUGE-LESSON-0");
    // The block is bounded: it cannot contain all 10 huge lessons.
    const matched = result.context.match(/HUGE-LESSON-/g) ?? [];
    expect(matched.length).toBeLessThan(10);
    expect(matched.length).toBeGreaterThan(0);
    // Total budget respected.
    expect(result.tokens).toBeLessThanOrEqual(5000);
  });
});
