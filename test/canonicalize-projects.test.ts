import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMigrateFunction } from "../src/functions/migrate.js";
import { KV } from "../src/state/schema.js";
import type {
  Action,
  AuditEntry,
  Crystal,
  Insight,
  Lesson,
  Memory,
  ProjectProfile,
  Session,
  SessionSummary,
  Sketch,
} from "../src/types.js";

type CanonicalizeScopeReport = {
  wouldUpdate: number;
  alreadyCanonical: number;
  noMatch: number;
  unscoped: number;
  deleted?: number;
  notes?: string;
};

type CanonicalizeResult = {
  success: true;
  step: "canonicalize-projects";
  dryRun: boolean;
  perScope: Record<string, CanonicalizeScopeReport>;
  totalUpdated: number;
  totalDeleted: number;
  totalNoMatch: number;
  totalUnscoped: number;
};

type CanonicalizeFailure = {
  success: false;
  step: "canonicalize-projects";
  error: string;
};

type MigrationPayload = {
  readonly step: "canonicalize-projects";
  readonly dryRun?: boolean;
  readonly mapping?: Record<string, string>;
};

type RegisteredHandler = (data: MigrationPayload) => Promise<unknown> | unknown;

function makeMockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const setCalls: Array<{ scope: string; key: string; value: unknown }> = [];
  const deleteCalls: Array<{ scope: string; key: string }> = [];

  return {
    store,
    setCalls,
    deleteCalls,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      setCalls.push({ scope, key, value: data });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)?.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      deleteCalls.push({ scope, key });
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function makeMockSdk() {
  const functions = new Map<string, RegisteredHandler>();
  return {
    registerFunction: (id: string, handler: RegisteredHandler): void => {
      functions.set(id, handler);
    },
    trigger: async (id: string, payload: MigrationPayload): Promise<unknown> => {
      const handler = functions.get(id);
      if (!handler) throw new Error(`No function: ${id}`);
      return handler(payload);
    },
  };
}

function registerSubject() {
  const sdk = makeMockSdk();
  const kv = makeMockKV();
  registerMigrateFunction(sdk as never, kv as never);

  return { sdk, kv };
}

const TEST_MAP: Record<string, string> = {
  "/repo-a/host-1": "proj-a",
  "/repo-a/host-2": "proj-a",
  "/repo-b/host-1": "proj-b",
  "/repo-b/host-2": "proj-b",
  "/repo-c/host-1": "proj-c",
  "old-name-c": "proj-c",
  "/repo-d/host-1": "proj-d",
  "/repo-e/host-1": "proj-e",
  "/repo-f/host-1": "proj-f",
  "/repo-g/host-1": "proj-g",
};

async function runCanonicalize(
  sdk: ReturnType<typeof makeMockSdk>,
  payload: MigrationPayload,
): Promise<CanonicalizeResult> {
  const effective: MigrationPayload =
    payload.mapping !== undefined ? payload : { ...payload, mapping: TEST_MAP };
  return (await sdk.trigger("mem::migrate", effective)) as CanonicalizeResult;
}

async function runCanonicalizeRaw(
  sdk: ReturnType<typeof makeMockSdk>,
  payload: MigrationPayload,
): Promise<CanonicalizeResult> {
  return (await sdk.trigger("mem::migrate", payload)) as CanonicalizeResult;
}

function session(id: string, project: string): Session {
  return {
    id,
    project,
    cwd: project,
    startedAt: "2026-06-20T00:00:00.000Z",
    status: "completed",
    observationCount: 0,
  };
}

function memory(id: string, project?: string): Memory {
  return {
    id,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    type: "fact",
    title: id,
    content: id,
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 1,
    version: 1,
    isLatest: true,
    ...(project !== undefined && { project }),
  };
}

function summary(sessionId: string, project: string): SessionSummary {
  return {
    sessionId,
    project,
    createdAt: "2026-06-20T00:00:00.000Z",
    title: sessionId,
    narrative: sessionId,
    keyDecisions: [],
    filesModified: [],
    concepts: [],
    observationCount: 0,
  };
}

function action(id: string, project?: string): Action {
  return {
    id,
    title: id,
    description: id,
    status: "pending",
    priority: 1,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    createdBy: "test",
    tags: [],
    sourceObservationIds: [],
    sourceMemoryIds: [],
    ...(project !== undefined && { project }),
  };
}

function sketch(id: string, project?: string): Sketch {
  return {
    id,
    title: id,
    description: id,
    status: "active",
    actionIds: [],
    createdAt: "2026-06-20T00:00:00.000Z",
    expiresAt: "2026-06-21T00:00:00.000Z",
    ...(project !== undefined && { project }),
  };
}

function crystal(id: string, project?: string): Crystal {
  return {
    id,
    narrative: id,
    keyOutcomes: [],
    filesAffected: [],
    lessons: [],
    sourceActionIds: [],
    createdAt: "2026-06-20T00:00:00.000Z",
    ...(project !== undefined && { project }),
  };
}

function lesson(id: string, project?: string): Lesson {
  return {
    id,
    content: id,
    context: id,
    confidence: 0.5,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    tags: [],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    decayRate: 0.01,
    ...(project !== undefined && { project }),
  };
}

function insight(id: string, project?: string): Insight {
  return {
    id,
    title: id,
    content: id,
    confidence: 0.5,
    reinforcements: 0,
    sourceConceptCluster: [],
    sourceMemoryIds: [],
    sourceLessonIds: [],
    sourceCrystalIds: [],
    tags: [],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    decayRate: 0.01,
    ...(project !== undefined && { project }),
  };
}

function profile(project: string): ProjectProfile {
  return {
    project,
    updatedAt: "2026-06-20T00:00:00.000Z",
    topConcepts: [],
    topFiles: [],
    conventions: [],
    commonErrors: [],
    recentActivity: [],
    sessionCount: 0,
    totalObservations: 0,
  };
}

describe("canonicalize-projects migration", () => {
  it("dry-run reports per-scope counts without mutation", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.sessions, "s1", session("s1", "/repo-a/host-2"));
    await kv.set(KV.sessions, "s2", session("s2", "proj-a"));
    await kv.set(KV.sessions, "s3", session("s3", "proj-g"));
    await kv.set(KV.sessions, "s4", session("s4", "unmapped-legacy"));
    await kv.set(KV.sessions, "s5", session("s5", ""));
    kv.setCalls.length = 0;

    const result = await runCanonicalize(sdk, {
      step: "canonicalize-projects",
      dryRun: true,
    });

    expect(result.perScope[KV.sessions]).toEqual({
      wouldUpdate: 1,
      alreadyCanonical: 2,
      noMatch: 1,
      unscoped: 1,
    });
    expect(result.perScope["mem:team:*:shared"]?.notes).toBe(
      "team scopes skipped: no enumerator",
    );
    expect(result.totalUpdated).toBe(0);
    expect(result.totalDeleted).toBe(0);
    expect(result.totalNoMatch).toBe(1);
    expect(result.totalUnscoped).toBe(1);
    expect(kv.setCalls).toHaveLength(0);
    expect(kv.deleteCalls).toHaveLength(0);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.project).toBe(
      "/repo-a/host-2",
    );
  });

  it("apply rewrites sessions correctly (path->slug)", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.sessions, "s1", session("s1", "/repo-a/host-2"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(result.perScope[KV.sessions]?.wouldUpdate).toBe(1);
    expect(result.totalUpdated).toBe(1);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.project).toBe("proj-a");
  });

  it("apply rewrites memories correctly (incl. old-name-c slug -> proj-c)", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.memories, "m1", memory("m1", "old-name-c"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(result.perScope[KV.memories]?.wouldUpdate).toBe(1);
    expect((await kv.get<Memory>(KV.memories, "m1"))?.project).toBe("proj-c");
  });

  it("apply rewrites lessons / summaries / actions / sketches / crystals / insights correctly", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.lessons, "l1", lesson("l1", "/repo-b/host-1"));
    await kv.set(KV.summaries, "sum1", summary("sum1", "/repo-c/host-1"));
    await kv.set(KV.actions, "a1", action("a1", "/repo-d/host-1"));
    await kv.set(KV.sketches, "sk1", sketch("sk1", "/repo-e/host-1"));
    await kv.set(KV.crystals, "c1", crystal("c1", "/repo-f/host-1"));
    await kv.set(KV.insights, "i1", insight("i1", "/repo-a/host-1"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(result.totalUpdated).toBe(6);
    expect((await kv.get<Lesson>(KV.lessons, "l1"))?.project).toBe("proj-b");
    expect((await kv.get<SessionSummary>(KV.summaries, "sum1"))?.project).toBe("proj-c");
    expect((await kv.get<Action>(KV.actions, "a1"))?.project).toBe("proj-d");
    expect((await kv.get<Sketch>(KV.sketches, "sk1"))?.project).toBe("proj-e");
    expect((await kv.get<Crystal>(KV.crystals, "c1"))?.project).toBe("proj-f");
    expect((await kv.get<Insight>(KV.insights, "i1"))?.project).toBe("proj-a");
  });

  it("apply DELETES path-keyed mem:profiles rows", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.profiles, "/repo-a/host-2", profile("/repo-a/host-2"));
    await kv.set(KV.profiles, "proj-a", profile("proj-a"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(result.perScope[KV.profiles]).toEqual({
      wouldUpdate: 0,
      alreadyCanonical: 1,
      noMatch: 0,
      unscoped: 0,
      deleted: 1,
    });
    expect(await kv.get<ProjectProfile>(KV.profiles, "/repo-a/host-2")).toBeNull();
    expect((await kv.get<ProjectProfile>(KV.profiles, "proj-a"))?.project).toBe("proj-a");
  });

  it("apply leaves rows whose project is not in the map untouched, counted as noMatch", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.memories, "m1", memory("m1", "unmapped-legacy"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(result.perScope[KV.memories]?.noMatch).toBe(1);
    expect(result.totalNoMatch).toBe(1);
    expect((await kv.get<Memory>(KV.memories, "m1"))?.project).toBe("unmapped-legacy");
  });

  it("apply leaves rows with empty/undefined project untouched, counted as unscoped", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.memories, "m1", memory("m1", ""));
    await kv.set(KV.actions, "a1", action("a1"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(result.perScope[KV.memories]?.unscoped).toBe(1);
    expect(result.perScope[KV.actions]?.unscoped).toBe(1);
    expect(result.totalUnscoped).toBe(2);
    expect((await kv.get<Memory>(KV.memories, "m1"))?.project).toBe("");
    expect((await kv.get<Action>(KV.actions, "a1"))?.project).toBeUndefined();
  });

  it("apply is idempotent: second invocation reports zero updates, zero deletions", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.memories, "m1", memory("m1", "old-name-c"));
    await kv.set(KV.profiles, "/repo-a/host-2", profile("/repo-a/host-2"));

    const first = await runCanonicalize(sdk, { step: "canonicalize-projects" });
    const second = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(first.totalUpdated).toBe(1);
    expect(first.totalDeleted).toBe(1);
    expect(second.totalUpdated).toBe(0);
    expect(second.totalDeleted).toBe(0);
  });

  it("apply writes exactly one audit row with the right operation string and per-scope counts", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.sessions, "s1", session("s1", "/repo-a/host-2"));
    await kv.set(KV.memories, "m1", memory("m1", "unknown-project"));
    await kv.set(KV.actions, "a1", action("a1"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });
    const audits = await kv.list<AuditEntry>(KV.audit);

    expect(result.totalUpdated).toBe(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.operation).toBe("canonicalize_projects");
    expect(audits[0]?.functionId).toBe("mem::migrate");
    expect(audits[0]?.targetIds).toEqual(["s1"]);
    expect(audits[0]?.details.perScope).toEqual(result.perScope);
    expect(audits[0]?.details.totalUpdated).toBe(1);
    expect(audits[0]?.details.totalNoMatch).toBe(1);
    expect(audits[0]?.details.totalUnscoped).toBe(1);
  });

  it("payload.mapping override replaces the default map verbatim", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.sessions, "s1", session("s1", "/custom/path"));
    await kv.set(KV.sessions, "s2", session("s2", "/repo-a/host-2"));

    const result = await runCanonicalize(sdk, {
      step: "canonicalize-projects",
      mapping: { "/custom/path": "custom-slug" },
    });
    const audits = await kv.list<AuditEntry>(KV.audit);

    expect(result.perScope[KV.sessions]).toEqual({
      wouldUpdate: 1,
      alreadyCanonical: 0,
      noMatch: 1,
      unscoped: 0,
    });
    expect((await kv.get<Session>(KV.sessions, "s1"))?.project).toBe("custom-slug");
    expect((await kv.get<Session>(KV.sessions, "s2"))?.project).toBe(
      "/repo-a/host-2",
    );
    expect(audits[0]?.details.mappingEntryCount).toBe(1);
    expect(audits[0]?.details.canonicalProjectCount).toBe(1);
    expect(audits[0]?.details).not.toHaveProperty("mapping");
  });

  it("apply aggregates worktrees of known repos into the main canonical slug", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.sessions, "s1", session("s1", "/repo-c/host-1/.worktrees/branch-x"));
    await kv.set(KV.sessions, "s2", session("s2", "/repo-b/host-2/.worktrees/branch-y"));
    await kv.set(KV.sessions, "s3", session("s3", "/repo-a/host-2/.worktrees/branch-z"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(result.perScope[KV.sessions]?.wouldUpdate).toBe(3);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.project).toBe("proj-c");
    expect((await kv.get<Session>(KV.sessions, "s2"))?.project).toBe("proj-b");
    expect((await kv.get<Session>(KV.sessions, "s3"))?.project).toBe("proj-a");
  });

  it("apply maps /repo-g path to proj-g slug", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.sessions, "s1", session("s1", "/repo-g/host-1"));
    await kv.set(KV.sessions, "s2", session("s2", "proj-g"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(result.perScope[KV.sessions]?.wouldUpdate).toBe(1);
    expect(result.perScope[KV.sessions]?.alreadyCanonical).toBe(1);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.project).toBe("proj-g");
    expect((await kv.get<Session>(KV.sessions, "s2"))?.project).toBe("proj-g");
  });

  it("apply classifies worktree of unknown repo as noMatch (not silently merged)", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.sessions, "s1", session("s1", "/unknown-repo/.worktrees/branch-x"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(result.perScope[KV.sessions]?.noMatch).toBe(1);
    expect(result.perScope[KV.sessions]?.wouldUpdate).toBe(0);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.project).toBe(
      "/unknown-repo/.worktrees/branch-x",
    );
  });


  it("empty default map + no payload.mapping classifies everything as noMatch but still deletes path-keyed profiles", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.sessions, "s1", session("s1", "/repo-a/host-1"));
    await kv.set(KV.memories, "m1", memory("m1", "proj-a"));
    await kv.set(KV.profiles, "/repo-a/host-1", profile("/repo-a/host-1"));
    await kv.set(KV.profiles, "proj-a", profile("proj-a"));

    const result = await runCanonicalizeRaw(sdk, { step: "canonicalize-projects" });
    const audits = await kv.list<AuditEntry>(KV.audit);

    expect(result.perScope[KV.sessions]?.noMatch).toBe(1);
    expect(result.perScope[KV.sessions]?.wouldUpdate).toBe(0);
    expect(result.perScope[KV.memories]?.noMatch).toBe(1);
    expect(result.perScope[KV.profiles]?.deleted).toBe(1);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.project).toBe("/repo-a/host-1");
    expect((await kv.get<Memory>(KV.memories, "m1"))?.project).toBe("proj-a");
    expect(await kv.get<ProjectProfile>(KV.profiles, "/repo-a/host-1")).toBeNull();
    expect((await kv.get<ProjectProfile>(KV.profiles, "proj-a"))?.project).toBe("proj-a");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.operation).toBe("canonicalize_projects");
    expect(audits[0]?.details.mappingEntryCount).toBe(0);
    expect(audits[0]?.details.canonicalProjectCount).toBe(0);
    expect(audits[0]?.details).not.toHaveProperty("mapping");
  });

  it.each([
    ["null mapping", null],
    ["array mapping", ["a", "b"]],
    ["primitive mapping", 42],
    ["non-string value", { "/some/path": 123 }],
    ["blank key", { "   ": "slug" }],
    ["blank value", { "/some/path": "   " }],
  ])("rejects %s with success:false and surfaces a descriptive error", async (_label, badMapping) => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.sessions, "s1", session("s1", "/repo-a/host-1"));

    const result = (await sdk.trigger("mem::migrate", {
      step: "canonicalize-projects",
      mapping: badMapping,
    } as never)) as CanonicalizeFailure;
    const audits = await kv.list<AuditEntry>(KV.audit);

    expect(result.success).toBe(false);
    expect(result.step).toBe("canonicalize-projects");
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
    expect(audits).toHaveLength(0);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.project).toBe("/repo-a/host-1");
  });

  it("accepts empty-object mapping as success path (treated as no-op default)", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.sessions, "s1", session("s1", "/repo-a/host-1"));

    const result = (await sdk.trigger("mem::migrate", {
      step: "canonicalize-projects",
      mapping: {},
    } as never)) as CanonicalizeResult;

    expect(result.success).toBe(true);
    expect(result.perScope[KV.sessions]?.noMatch).toBe(1);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.project).toBe("/repo-a/host-1");
  });

  it("redacts path-shaped profile keys from audit targetIds (no raw paths persisted)", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.profiles, "/repo-a/host-1", profile("/repo-a/host-1"));
    await kv.set(KV.profiles, "/repo-b/host-2/.worktrees/branch-y", profile("/repo-b/host-2/.worktrees/branch-y"));
    await kv.set(KV.sessions, "s1", session("s1", "/repo-a/host-1"));

    await runCanonicalize(sdk, { step: "canonicalize-projects" });
    const audits = await kv.list<AuditEntry>(KV.audit);

    expect(audits).toHaveLength(1);
    const targetIds = audits[0]?.targetIds ?? [];
    for (const id of targetIds) {
      expect(id.startsWith("/")).toBe(false);
      expect(id.includes("/.worktrees/")).toBe(false);
      expect(id).not.toMatch(/repo-[a-z]/);
      expect(id).not.toMatch(/host-\d/);
    }
    const redacted = targetIds.filter((id) => id.startsWith("profile-key:"));
    expect(redacted).toHaveLength(2);
    for (const id of redacted) {
      expect(id).toMatch(/^profile-key:[0-9a-f]{16}$/);
    }
  });

  it("deletes profiles keyed by non-path mapping keys when migrating to a different canonical slug", async () => {
    const { sdk, kv } = registerSubject();
    await kv.set(KV.profiles, "old-name-c", profile("old-name-c"));
    await kv.set(KV.profiles, "proj-c", profile("proj-c"));

    const result = await runCanonicalize(sdk, { step: "canonicalize-projects" });

    expect(result.perScope[KV.profiles]?.deleted).toBe(1);
    expect(result.perScope[KV.profiles]?.alreadyCanonical).toBe(1);
    expect(await kv.get<ProjectProfile>(KV.profiles, "old-name-c")).toBeNull();
    expect((await kv.get<ProjectProfile>(KV.profiles, "proj-c"))?.project).toBe("proj-c");
  });

});
