import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerProfileFunction } from "../src/functions/profile.js";
import type {
  CompressedObservation,
  Session,
  SessionSummary,
  Memory,
  ProjectProfile,
} from "../src/types.js";

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
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function session(
  id: string,
  project: string,
  startedAt = "2026-02-01T00:00:00Z",
): Session {
  return {
    id,
    project,
    cwd: `/tmp/${id}`,
    startedAt,
    status: "completed",
    observationCount: 0,
  };
}

function obs(
  id: string,
  sessionId: string,
  partial: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-02-01T10:00:00Z",
    type: "other",
    title: id,
    facts: [],
    narrative: "",
    concepts: [],
    files: [],
    importance: 5,
    ...partial,
  };
}

function summary(
  sessionId: string,
  project: string,
  partial: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId,
    project,
    createdAt: "2026-02-01T10:00:00Z",
    title: `summary ${sessionId}`,
    narrative: "",
    keyDecisions: [],
    filesModified: [],
    concepts: [],
    observationCount: 0,
    ...partial,
  };
}

function memory(id: string, partial: Partial<Memory> = {}): Memory {
  return {
    id,
    createdAt: "2026-02-01T10:00:00Z",
    updatedAt: "2026-02-01T10:00:00Z",
    type: "fact",
    title: id,
    content: "",
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 1,
    version: 1,
    isLatest: true,
    ...partial,
  };
}

describe("Profile Function - core", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerProfileFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_1", session("ses_1", "my-project"));
    await kv.set(
      "mem:obs:ses_1",
      "obs_1",
      obs("obs_1", "ses_1", {
        type: "file_edit",
        title: "Edit auth module",
        concepts: ["typescript", "authentication"],
        files: ["/project/src/auth.ts", "/project/src/middleware.ts"],
        importance: 8,
      }),
    );
    await kv.set(
      "mem:obs:ses_1",
      "obs_2",
      obs("obs_2", "ses_1", {
        type: "file_edit",
        title: "Update database",
        concepts: ["typescript", "database"],
        files: ["/project/src/db.ts"],
        importance: 6,
      }),
    );
    await kv.set(
      "mem:obs:ses_1",
      "obs_3",
      obs("obs_3", "ses_1", {
        type: "error",
        title: "Connection timeout",
        concepts: ["error"],
        files: ["/project/src/db.ts"],
        importance: 4,
      }),
    );
  });

  it("counts concept frequency by distinct session, not raw occurrence", async () => {
    const result = (await sdk.trigger("mem::profile", {
      project: "my-project",
    })) as { profile: ProjectProfile; cached: boolean };

    expect(result.cached).toBe(false);
    const ts = result.profile.topConcepts.find((c) => c.concept === "typescript");
    expect(ts).toBeDefined();
    // typescript appears in obs_1 and obs_2, but both live in ses_1 -> one bucket
    expect(ts!.frequency).toBe(1);
  });

  it("counts file frequency by distinct session, not raw occurrence", async () => {
    const result = (await sdk.trigger("mem::profile", {
      project: "my-project",
    })) as { profile: ProjectProfile };

    const db = result.profile.topFiles.find((f) => f.file === "/project/src/db.ts");
    expect(db).toBeDefined();
    // db.ts appears in obs_2 and obs_3, both in ses_1 -> frequency 1
    expect(db!.frequency).toBe(1);
  });

  it("extracts conventions from file patterns", async () => {
    const result = (await sdk.trigger("mem::profile", {
      project: "my-project",
    })) as { profile: ProjectProfile };

    expect(result.profile.conventions).toContain("TypeScript project");
    expect(result.profile.conventions).toContain(
      "Standard src/ directory structure",
    );
  });

  it("derives commonErrors from error observations", async () => {
    const result = (await sdk.trigger("mem::profile", {
      project: "my-project",
    })) as { profile: ProjectProfile };

    expect(result.profile.commonErrors).toContain("Connection timeout");
  });

  it("returns cached profile if fresh", async () => {
    await sdk.trigger("mem::profile", { project: "my-project" });

    const result = (await sdk.trigger("mem::profile", {
      project: "my-project",
    })) as { profile: ProjectProfile; cached: boolean };

    expect(result.cached).toBe(true);
  });

  it("returns null profile for unknown project", async () => {
    const result = (await sdk.trigger("mem::profile", {
      project: "nonexistent",
    })) as { profile: null; reason: string };

    expect(result.profile).toBeNull();
    expect(result.reason).toBe("no_sessions");
  });
});

describe("Profile Function - multi-source aggregation (bug fix)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerProfileFunction(sdk as never, kv as never);
  });

  it("derives topFiles from synthetic observation subtitle.filePath when files[] is empty", async () => {
    await kv.set("mem:sessions", "s1", session("s1", "/proj"));
    await kv.set(
      "mem:obs:s1",
      "o1",
      obs("o1", "s1", {
        type: "file_read",
        subtitle: JSON.stringify({ filePath: "/proj/src/app.ts" }),
      }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    expect(r.profile.topFiles.map((f) => f.file)).toContain("/proj/src/app.ts");
  });

  it("aggregates concepts and files from session summaries", async () => {
    await kv.set("mem:sessions", "s1", session("s1", "/proj"));
    await kv.set(
      "mem:summaries",
      "s1",
      summary("s1", "/proj", {
        concepts: ["graphql", "caching"],
        filesModified: ["/proj/src/resolver.ts"],
      }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    expect(r.profile.topConcepts.map((c) => c.concept)).toEqual(
      expect.arrayContaining(["graphql", "caching"]),
    );
    expect(r.profile.topFiles.map((f) => f.file)).toContain("/proj/src/resolver.ts");
  });

  it("aggregates concepts and files from project-scoped memories", async () => {
    await kv.set("mem:sessions", "s1", session("s1", "/proj"));
    await kv.set(
      "mem:memories",
      "m1",
      memory("m1", {
        project: "/proj",
        concepts: ["observability"],
        files: ["/proj/src/metrics.ts"],
      }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    expect(r.profile.topConcepts.map((c) => c.concept)).toContain("observability");
    expect(r.profile.topFiles.map((f) => f.file)).toContain("/proj/src/metrics.ts");
  });

  it("excludes memories that are neither project-scoped nor session-linked", async () => {
    await kv.set("mem:sessions", "s1", session("s1", "/proj"));
    await kv.set(
      "mem:memories",
      "m_other",
      memory("m_other", {
        project: "/other-project",
        concepts: ["unrelated"],
        files: ["/other-project/x.ts"],
      }),
    );
    await kv.set(
      "mem:memories",
      "m_unscoped",
      memory("m_unscoped", {
        concepts: ["alsounrelated"],
        files: ["/somewhere/y.ts"],
        sessionIds: ["ses_not_in_project"],
      }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    const concepts = r.profile.topConcepts.map((c) => c.concept);
    expect(concepts).not.toContain("unrelated");
    expect(concepts).not.toContain("alsounrelated");
  });

  it("excludes superseded (isLatest === false) memories", async () => {
    await kv.set("mem:sessions", "s1", session("s1", "/proj"));
    await kv.set(
      "mem:memories",
      "m_old",
      memory("m_old", {
        project: "/proj",
        concepts: ["supersededconcept"],
        isLatest: false,
      }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    expect(r.profile.topConcepts.map((c) => c.concept)).not.toContain(
      "supersededconcept",
    );
  });

  it("includes memories linked by sessionId even without a project field", async () => {
    await kv.set("mem:sessions", "s1", session("s1", "/proj"));
    await kv.set(
      "mem:memories",
      "m_linked",
      memory("m_linked", {
        concepts: ["linkedconcept"],
        files: ["/proj/src/linked.ts"],
        sessionIds: ["s1"],
      }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    expect(r.profile.topConcepts.map((c) => c.concept)).toContain("linkedconcept");
  });

  it("ranks files by distinct session count across summaries", async () => {
    for (const sid of ["s1", "s2", "s3"]) {
      await kv.set("mem:sessions", sid, session(sid, "/proj"));
    }
    await kv.set(
      "mem:summaries",
      "s1",
      summary("s1", "/proj", { filesModified: ["/proj/a.ts"] }),
    );
    await kv.set(
      "mem:summaries",
      "s2",
      summary("s2", "/proj", { filesModified: ["/proj/a.ts"] }),
    );
    await kv.set(
      "mem:summaries",
      "s3",
      summary("s3", "/proj", { filesModified: ["/proj/b.ts"] }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    const a = r.profile.topFiles.find((f) => f.file === "/proj/a.ts");
    const b = r.profile.topFiles.find((f) => f.file === "/proj/b.ts");
    expect(a!.frequency).toBe(2);
    expect(b!.frequency).toBe(1);
    expect(r.profile.topFiles[0].file).toBe("/proj/a.ts");
  });

  it("dedups a file counted from both a summary and an observation in the same session", async () => {
    await kv.set("mem:sessions", "s1", session("s1", "/proj"));
    await kv.set(
      "mem:summaries",
      "s1",
      summary("s1", "/proj", { filesModified: ["/proj/dup.ts"] }),
    );
    await kv.set(
      "mem:obs:s1",
      "o1",
      obs("o1", "s1", { type: "file_edit", files: ["/proj/dup.ts"] }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    const dup = r.profile.topFiles.find((f) => f.file === "/proj/dup.ts");
    expect(dup!.frequency).toBe(1);
  });

  it("excludes subtitle file paths outside an absolute-path project", async () => {
    await kv.set("mem:sessions", "s1", session("s1", "/proj"));
    await kv.set(
      "mem:obs:s1",
      "o1",
      obs("o1", "s1", {
        type: "file_read",
        subtitle: JSON.stringify({ filePath: "/tmp/scratch.ts" }),
      }),
    );
    await kv.set(
      "mem:obs:s1",
      "o2",
      obs("o2", "s1", {
        type: "file_read",
        subtitle: JSON.stringify({ filePath: "/proj/keep.ts" }),
      }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    const files = r.profile.topFiles.map((f) => f.file);
    expect(files).toContain("/proj/keep.ts");
    expect(files).not.toContain("/tmp/scratch.ts");
  });

  it("aggregates summaries from sessions beyond the legacy 20-session cap", async () => {
    for (let i = 0; i < 25; i++) {
      const startedAt = `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`;
      await kv.set("mem:sessions", `s${i}`, session(`s${i}`, "/proj", startedAt));
    }
    // s0 is the OLDEST session (feb 1), well outside the newest-20 window
    await kv.set(
      "mem:summaries",
      "s0",
      summary("s0", "/proj", { concepts: ["oldestconcept"] }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    expect(r.profile.topConcepts.map((c) => c.concept)).toContain("oldestconcept");
  });

  it("scans observations from sessions beyond the legacy 20-session cap", async () => {
    for (let i = 0; i < 25; i++) {
      const startedAt = `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`;
      await kv.set("mem:sessions", `s${i}`, session(`s${i}`, "/proj", startedAt));
    }
    // s0 is the OLDEST session; its file only exists in an observation subtitle
    await kv.set(
      "mem:obs:s0",
      "o1",
      obs("o1", "s0", {
        type: "file_read",
        subtitle: JSON.stringify({ filePath: "/proj/oldfile.ts" }),
      }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    expect(r.profile.topFiles.map((f) => f.file)).toContain("/proj/oldfile.ts");
  });

  it("uses session summaries for recentActivity", async () => {
    await kv.set("mem:sessions", "s1", session("s1", "/proj"));
    await kv.set(
      "mem:summaries",
      "s1",
      summary("s1", "/proj", {
        title: "Implemented resolver cache",
        createdAt: "2026-02-05T09:00:00Z",
      }),
    );

    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    expect(
      r.profile.recentActivity.some((a) => a.includes("Implemented resolver cache")),
    ).toBe(true);
  });

  it("reports totalObservations from all project sessions, not just the scanned window", async () => {
    const s1 = session("s1", "/proj");
    s1.observationCount = 5000;
    await kv.set("mem:sessions", "s1", s1);
    // no observations seeded into the obs scope; metadata is the only source
    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    expect(r.profile.totalObservations).toBe(5000);
  });

  it("uses scanned observation count when it exceeds stale session metadata", async () => {
    const s1 = session("s1", "/proj");
    s1.observationCount = 0;
    await kv.set("mem:sessions", "s1", s1);
    await kv.set("mem:obs:s1", "o1", obs("o1", "s1"));
    await kv.set("mem:obs:s1", "o2", obs("o2", "s1"));
    const r = (await sdk.trigger("mem::profile", { project: "/proj" })) as {
      profile: ProjectProfile;
    };
    expect(r.profile.totalObservations).toBe(2);
  });
});
