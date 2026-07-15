import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerProfileFunction,
  canonicalizeFilePath,
} from "../src/functions/profile.js";
import { canonicalizeProfilePaths } from "../src/functions/migrate.js";
import { KV } from "../src/state/schema.js";
import type { Session, SessionSummary, ProjectProfile } from "../src/types.js";

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
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function session(id: string, project: string): Session {
  return {
    id,
    project,
    cwd: `/tmp/${id}`,
    startedAt: "2026-02-01T00:00:00Z",
    status: "completed",
    observationCount: 0,
  } as Session;
}

function summary(
  sessionId: string,
  project: string,
  filesModified: string[],
): SessionSummary {
  return {
    sessionId,
    project,
    createdAt: "2026-02-01T10:00:00Z",
    title: `summary ${sessionId}`,
    narrative: "",
    keyDecisions: [],
    filesModified,
    concepts: [],
    observationCount: 0,
  } as SessionSummary;
}

describe("Profile file-path canonicalization (Task 16 Item 2)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerProfileFunction(sdk as never, kv as never);
  });

  it("canonicalizes mixed absolute/relative paths to one portable form", async () => {
    await kv.set(KV.sessions, "ses_1", session("ses_1", "myapp"));
    await kv.set(
      KV.summaries,
      "ses_1",
      summary("ses_1", "myapp", [
        "/Users/dev/myapp/src/index.ts",
        "src/index.ts",
      ]),
    );

    const res = (await sdk.trigger("mem::profile", {
      project: "myapp",
      refresh: true,
    })) as { profile: ProjectProfile };

    const files = res.profile.topFiles.map((f) => f.file);
    // Both forms converge to the portable project-relative path.
    expect(files).toEqual(["src/index.ts"]);
    expect(files).not.toContain("/Users/dev/myapp/src/index.ts");
  });

  it("canonicalizeFilePath normalizes abs-project paths in place, relativizes slug paths, and handles trailing slash / backslash / empty input", () => {
    // Absolute project root: relative files are already filtered out
    // upstream, so there is no mix to fix. Paths pass through normalized
    // (NOT relativized) so existing absolute-project profiles are stable.
    expect(canonicalizeFilePath("/repo/app/src/a.ts", "/repo/app")).toBe(
      "/repo/app/src/a.ts",
    );
    // Redundant . / .. and dup slashes collapse even for abs projects.
    expect(
      canonicalizeFilePath("/repo/app/./src/../src/a.ts", "/repo/app"),
    ).toBe("/repo/app/src/a.ts");
    // Slug project: absolute path carrying the slug segment relativizes.
    expect(
      canonicalizeFilePath("/Users/x/myapp/src/a.ts", "myapp"),
    ).toBe("src/a.ts");
    // Windows separators are normalized to posix.
    expect(canonicalizeFilePath("src\\a.ts", "myapp")).toBe("src/a.ts");
    // Windows drive-letter absolute path carrying the slug segment
    // relativizes too (adversarial probe finding).
    expect(
      canonicalizeFilePath("C:\\Users\\x\\myapp\\src\\a.ts", "myapp"),
    ).toBe("src/a.ts");
    // Trailing slash on a file is stripped.
    expect(canonicalizeFilePath("src/dir/", "myapp")).toBe("src/dir");
    // Redundant . / .. segments collapse.
    expect(canonicalizeFilePath("./src/../src/a.ts", "myapp")).toBe(
      "src/a.ts",
    );
    // Empty / whitespace input yields empty string (dropped upstream).
    expect(canonicalizeFilePath("   ", "myapp")).toBe("");
    // Idempotent: canonical(canonical(x)) === canonical(x).
    const once = canonicalizeFilePath("/Users/x/myapp/src/a.ts", "myapp");
    expect(canonicalizeFilePath(once, "myapp")).toBe(once);
  });

  it("canonicalizeProfilePaths normalizes already-stored profiles and is idempotent (STALE STATE)", async () => {
    const stored: ProjectProfile = {
      project: "myapp",
      updatedAt: "2026-02-01T00:00:00Z",
      topConcepts: [],
      topFiles: [
        { file: "/Users/dev/myapp/src/index.ts", frequency: 2 },
        { file: "src/index.ts", frequency: 1 },
        { file: "lib/util.ts", frequency: 1 },
      ],
      conventions: [],
      commonErrors: [],
      recentActivity: [],
      sessionCount: 1,
      totalObservations: 1,
    } as ProjectProfile;
    await kv.set(KV.profiles, "myapp", stored);

    const first = await canonicalizeProfilePaths(kv as never, false);
    expect(first.profilesUpdated).toBe(1);

    const after = (await kv.get(KV.profiles, "myapp")) as ProjectProfile;
    const files = after.topFiles.map((f) => f.file);
    // The two forms of index.ts merge; frequencies sum.
    expect(files).toContain("src/index.ts");
    expect(files).toContain("lib/util.ts");
    expect(files).not.toContain("/Users/dev/myapp/src/index.ts");
    const merged = after.topFiles.find((f) => f.file === "src/index.ts");
    expect(merged!.frequency).toBe(3);

    // Running again is a no-op (already canonical, no double-normalize).
    const second = await canonicalizeProfilePaths(kv as never, false);
    expect(second.profilesUpdated).toBe(0);
  });
});
