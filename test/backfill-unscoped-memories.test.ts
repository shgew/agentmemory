import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  inferMemoryProjects,
  backfillUnscopedMemories,
} from "../src/functions/migrate.js";
import { KV } from "../src/state/schema.js";
import type { Memory, Session, AuditEntry } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
    getStore: () => store,
  };
}

function memory(id: string, sessionIds: string[], project?: string): Memory {
  return {
    id,
    title: `mem ${id}`,
    content: "c",
    type: "fact",
    project,
    sessionIds,
    confidence: 0.5,
    createdAt: new Date().toISOString(),
    isLatest: true,
  } as Memory;
}

function session(id: string, project: string): Session {
  return {
    id,
    project,
    cwd: `/tmp/${id}`,
    startedAt: new Date().toISOString(),
    status: "completed",
    observationCount: 0,
  } as Session;
}

describe("Backfill unscoped memories (Task 16 Item 1)", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("assigns a project from the linked session's majority AND records an audit trail per backfill", async () => {
    await kv.set(KV.sessions, "ses_1", session("ses_1", "proj-a"));
    await kv.set(KV.memories, "mem_1", memory("mem_1", ["ses_1"]));

    const result = await inferMemoryProjects(kv as never, false);
    expect(result.updated).toBe(1);

    const stored = (await kv.get(KV.memories, "mem_1")) as Memory;
    expect(stored.project).toBe("proj-a");

    // The gap the audit flagged: a backfill mutated a memory's scope
    // but left NO audit trail. After the fix an audit row must name
    // the backfilled memory and the project it was assigned.
    const audits = (await kv.list(KV.audit)) as AuditEntry[];
    const backfillAudit = audits.find((a) => a.targetIds.includes("mem_1"));
    expect(backfillAudit).toBeDefined();
    expect((backfillAudit!.details as any).project).toBe("proj-a");
  });

  it("backfillUnscopedMemories reports unresolvable memories explicitly instead of silently leaving them unscoped", async () => {
    // No linked sessions -> cannot be confidently assigned.
    await kv.set(KV.memories, "mem_orphan", memory("mem_orphan", []));
    // Conflicting sessions with no majority -> ambiguous.
    await kv.set(KV.sessions, "ses_a", session("ses_a", "proj-a"));
    await kv.set(KV.sessions, "ses_b", session("ses_b", "proj-b"));
    await kv.set(
      KV.memories,
      "mem_split",
      memory("mem_split", ["ses_a", "ses_b"]),
    );

    const report = await backfillUnscopedMemories(kv as never, false);

    expect(report.updated).toBe(0);
    expect(report.unresolvedIds).toEqual(
      expect.arrayContaining(["mem_orphan", "mem_split"]),
    );
    // Still unscoped, and explicitly reported (not silently dropped).
    const orphan = (await kv.get(KV.memories, "mem_orphan")) as Memory;
    expect(orphan.project).toBeUndefined();
  });
});
