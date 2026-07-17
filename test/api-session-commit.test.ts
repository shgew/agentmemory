import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { KV } from "../src/state/schema.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
import type { CommitLink, Session } from "../src/types.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";

type Handler = (data: unknown) => unknown | Promise<unknown>;
type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function deferred(): Deferred {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  let blockedSet: {
    readonly scope: string;
    readonly key: string;
    readonly entered: Deferred;
    readonly release: Deferred;
  } | null = null;
  const seed = (scope: string, key: string, value: unknown): void => {
    if (!store.has(scope)) store.set(scope, new Map());
    store.get(scope)?.set(key, value);
  };
  return {
    seed,
    blockFirstSet: (scope: string, key: string) => {
      const block = {
        scope,
        key,
        entered: deferred(),
        release: deferred(),
      };
      blockedSet = block;
      return block;
    },
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      const block = blockedSet;
      if (block?.scope === scope && block.key === key) {
        blockedSet = null;
        block.entered.resolve();
        await block.release.promise;
      }
      seed(scope, key, value);
      return value;
    },
    update: async <T>(
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ): Promise<T> => {
      const current = (store.get(scope)?.get(key) as Record<string, unknown>) ?? {};
      const next = { ...current };
      for (const op of ops) if (op.type === "set") next[op.path] = op.value;
      seed(scope, key, next);
      return next as T;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, Handler>();
  return {
    registerFunction: (
      idOrOptions: string | { id: string },
      handler: Handler,
    ): void => {
      functions.set(
        typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id,
        handler,
      );
    },
    registerTrigger: (): void => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      functions.get(input.function_id)?.(input.payload),
    getFunction: (id: string): Handler => {
      const handler = functions.get(id);
      if (!handler) throw new Error(`Function ${id} was not registered`);
      return handler;
    },
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    project: "proj",
    cwd: "/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    observationCount: 0,
    ...overrides,
  };
}

function postBody(body: Record<string, unknown>) {
  return { body, headers: {}, query_params: {} };
}

function getReq(query_params: Record<string, unknown>) {
  return { body: {}, headers: {}, query_params };
}

async function mcpCall(
  handler: Handler,
  name: string,
  args: Record<string, unknown>,
) {
  const res = (await handler({ body: { name, arguments: args } })) as {
    status_code: number;
    body: { content?: Array<{ text: string }> };
  };
  const text = res.body.content?.[0]?.text ?? "{}";
  return { res, parsed: JSON.parse(text) as Record<string, unknown> };
}

const SHA40 = "abc123def456abc123def456abc123def456abcd";
const SHA64 =
  "abc123def456abc123def456abc123def456abc123def456abc123def456abcd";
const HTTPS_REPO = "https://user:access-token@git.example.com/org/repo.git";
const HTTPS_QUERY_REPO = "https://viewer:query-token@git.example.com/org/repo.git";
const SCP_REPO = "access-token@git.example.com:org/repo.git";
const REPO_FILTER_CASES = [
  [
    "credential-bearing HTTPS",
    SHA40,
    HTTPS_QUERY_REPO,
    HTTPS_REPO,
    "https://git.example.com/org/repo.git",
  ],
  [
    "git SCP",
    SHA64,
    "git@git.example.com:org/repo.git",
    "git.example.com:org/repo.git",
    "git.example.com:org/repo.git",
  ],
] as const;

describe("api::session::commit ingest", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let commit: Handler;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AGENT_ID", "");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "");
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    commit = sdk.getFunction("api::session::commit");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["non-hex", "zzz123def456abc123def456abc123def456abcd"],
    ["too short", "abc123"],
    ["wrong length (41)", `${SHA40}a`],
    ["empty", ""],
  ])("rejects invalid sha: %s", async (_label, sha) => {
    const res = (await commit(postBody({ sha }))) as { status_code: number };
    expect(res.status_code).toBe(400);
  });

  it("accepts a 40-char sha and normalizes to lowercase", async () => {
    const res = (await commit(
      postBody({ sha: SHA40.toUpperCase() }),
    )) as { status_code: number; body: { commit: CommitLink } };
    expect(res.status_code).toBe(200);
    expect(res.body.commit.sha).toBe(SHA40);
    expect(await kv.get<CommitLink>(KV.commits, SHA40)).not.toBeNull();
  });

  it("accepts a 64-char sha", async () => {
    const res = (await commit(postBody({ sha: SHA64 }))) as {
      status_code: number;
    };
    expect(res.status_code).toBe(200);
  });

  it("truncates an oversize message to 2000 chars", async () => {
    const res = (await commit(
      postBody({ sha: SHA40, message: "m".repeat(3000) }),
    )) as { status_code: number; body: { commit: CommitLink } };
    expect(res.status_code).toBe(200);
    expect(res.body.commit.message?.length).toBe(2000);
  });

  it.each(["branch", "repo", "author", "authoredAt"])(
    "rejects an oversize %s field",
    async (field) => {
      const res = (await commit(
        postBody({ sha: SHA40, [field]: "x".repeat(2001) }),
      )) as { status_code: number };
      expect(res.status_code).toBe(400);
    },
  );

  it("caps the files array at 200 entries and truncates each to 1000 chars", async () => {
    const files = Array.from({ length: 250 }, () => "f".repeat(1500));
    const res = (await commit(postBody({ sha: SHA40, files }))) as {
      status_code: number;
      body: { commit: CommitLink };
    };
    expect(res.body.commit.files?.length).toBe(200);
    expect(res.body.commit.files?.every((f) => f.length === 1000)).toBe(true);
  });

  it("preserves existing metadata on re-post (existing-wins), still merges sessionIds", async () => {
    await commit(postBody({ sha: SHA40, sessionId: "s1", message: "first" }));
    await commit(
      postBody({ sha: SHA40, sessionId: "s2", message: "second", branch: "main" }),
    );
    const link = await kv.get<CommitLink>(KV.commits, SHA40);
    expect(link?.message).toBe("first");
    expect(link?.branch).toBe("main");
    expect(link?.sessionIds.sort()).toEqual(["s1", "s2"]);
  });

  it("403s when a body agentId differs from the target session's agentId and writes nothing", async () => {
    kv.seed(KV.sessions, "s1", session({ id: "s1", agentId: "agent-a" }));
    const res = (await commit(
      postBody({ sha: SHA40, sessionId: "s1", agentId: "agent-b" }),
    )) as { status_code: number };
    expect(res.status_code).toBe(403);
    expect(await kv.get<CommitLink>(KV.commits, SHA40)).toBeNull();
    expect(
      (await kv.get<Session>(KV.sessions, "s1"))?.commitShas,
    ).toBeUndefined();
  });

  it("403s under env isolation when linking to another agent's session", async () => {
    vi.stubEnv("AGENT_ID", "agent-b");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    kv.seed(KV.sessions, "s1", session({ id: "s1", agentId: "agent-a" }));
    const res = (await commit(
      postBody({ sha: SHA40, sessionId: "s1" }),
    )) as { status_code: number };
    expect(res.status_code).toBe(403);
    expect(await kv.get<CommitLink>(KV.commits, SHA40)).toBeNull();
  });

  it("allows linking to the caller's own session under isolation", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    kv.seed(KV.sessions, "s1", session({ id: "s1", agentId: "agent-a" }));
    const res = (await commit(
      postBody({ sha: SHA40, sessionId: "s1" }),
    )) as { status_code: number };
    expect(res.status_code).toBe(200);
    expect(
      (await kv.get<Session>(KV.sessions, "s1"))?.commitShas,
    ).toEqual([SHA40]);
  });

  it("holds the session lock from final ownership validation through the commit update", async () => {
    kv.seed(KV.sessions, "s1", session({ id: "s1", agentId: "agent-a" }));
    const commitWrite = kv.blockFirstSet(KV.commits, SHA40);
    const request = commit(
      postBody({ sha: SHA40, sessionId: "s1", agentId: "agent-a" }),
    );

    await commitWrite.entered.promise;
    let ownershipChanged = false;
    const ownershipChange = withKeyedLock("session:s1", async () => {
      ownershipChanged = true;
      await kv.update<Session>(KV.sessions, "s1", [
        { type: "set", path: "agentId", value: "agent-b" },
      ]);
    });
    await Promise.resolve();
    await Promise.resolve();
    const ownershipChangedDuringCommitWrite = ownershipChanged;

    commitWrite.release.resolve();
    const result = (await request) as { status_code: number };
    await ownershipChange;

    expect(result.status_code).toBe(200);
    expect(ownershipChangedDuringCommitWrite).toBe(false);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.commitShas).toEqual([
      SHA40,
    ]);
  });

  it("hides other agents' session IDs from an isolated commit response", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    kv.seed(KV.sessions, "s1", session({ id: "s1", agentId: "agent-a" }));
    kv.seed(KV.sessions, "s2", session({ id: "s2", agentId: "agent-b" }));
    kv.seed(KV.commits, SHA40, {
      sha: SHA40,
      shortSha: SHA40.slice(0, 7),
      branch: "agent-b-private",
      repo: "https://git.example.com/agent-b/private.git",
      sessionIds: ["s1", "s2"],
      linkedAt: "2026-01-01T00:00:00.000Z",
    } satisfies CommitLink);

    const res = (await commit(
      postBody({ sha: SHA40, sessionId: "s1" }),
    )) as { status_code: number; body: { commit: CommitLink } };

    expect(res.status_code).toBe(200);
    expect(res.body.commit.sessionIds).toEqual(["s1"]);
    expect(res.body.commit.branch).toBeUndefined();
    expect(res.body.commit.repo).toBeUndefined();
  });

  it("rejects an isolated link to a SHA retained only by another agent", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    kv.seed(KV.sessions, "s1", session({ id: "s1", agentId: "agent-a" }));
    kv.seed(KV.sessions, "s2", session({ id: "s2", agentId: "agent-b" }));
    const foreignCommit = {
      sha: SHA40,
      shortSha: SHA40.slice(0, 7),
      message: "agent B private commit metadata",
      sessionIds: ["s2"],
      linkedAt: "2026-01-01T00:00:00.000Z",
    } satisfies CommitLink;
    kv.seed(KV.commits, SHA40, foreignCommit);

    const res = (await commit(postBody({ sha: SHA40, sessionId: "s1" }))) as {
      status_code: number;
      body: Record<string, unknown>;
    };

    expect(res.status_code).toBe(403);
    expect(res.body).toEqual({
      error: "commit is linked only to sessions owned by another agent",
    });
    expect(await kv.get(KV.commits, SHA40)).toEqual(foreignCommit);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.commitShas).toBeUndefined();
  });

  it("rejects an isolated link to a SHA retained only by deleted sessions", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    kv.seed(KV.sessions, "s1", session({ id: "s1", agentId: "agent-a" }));
    const deletedSessionCommit = {
      sha: SHA40,
      shortSha: SHA40.slice(0, 7),
      message: "retained commit metadata",
      sessionIds: ["deleted-session"],
      linkedAt: "2026-01-01T00:00:00.000Z",
    } satisfies CommitLink;
    kv.seed(KV.commits, SHA40, deletedSessionCommit);

    const res = (await commit(postBody({ sha: SHA40, sessionId: "s1" }))) as {
      status_code: number;
      body: Record<string, unknown>;
    };

    expect(res.status_code).toBe(403);
    expect(res.body).toEqual({
      error: "commit is linked only to sessions owned by another agent",
    });
    expect(await kv.get(KV.commits, SHA40)).toEqual(deletedSessionCommit);
    expect((await kv.get<Session>(KV.sessions, "s1"))?.commitShas).toBeUndefined();
  });

  it("strips repository credentials before storing a direct commit report", async () => {
    const res = (await commit(
      postBody({
        sha: SHA40,
        repo: "https://user:access-token@git.example.com/org/repo.git",
      }),
    )) as { status_code: number; body: { commit: CommitLink } };

    expect(res.status_code).toBe(200);
    expect(res.body.commit.repo).toBe("https://git.example.com/org/repo.git");
    expect((await kv.get<CommitLink>(KV.commits, SHA40))?.repo).toBe(
      "https://git.example.com/org/repo.git",
    );
  });

  it("strips SCP-style repository credentials before storing a direct commit report", async () => {
    const res = (await commit(
      postBody({
        sha: SHA40,
        repo: "access-token@git.example.com:org/repo.git",
      }),
    )) as { status_code: number; body: { commit: CommitLink } };

    expect(res.status_code).toBe(200);
    expect(res.body.commit.repo).toBe("git.example.com:org/repo.git");
    expect((await kv.get<CommitLink>(KV.commits, SHA40))?.repo).toBe(
      "git.example.com:org/repo.git",
    );
  });

  it("sanitizes retained repository metadata before replying", async () => {
    kv.seed(KV.commits, SHA40, {
      sha: SHA40,
      shortSha: SHA40.slice(0, 7),
      repo: "https://user:access-token@git.example.com/org/repo.git",
      sessionIds: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    } satisfies CommitLink);

    const res = (await commit(postBody({ sha: SHA40 }))) as {
      status_code: number;
      body: { commit: CommitLink };
    };

    expect(res.status_code).toBe(200);
    expect(res.body.commit.repo).toBe("https://git.example.com/org/repo.git");
    expect((await kv.get<CommitLink>(KV.commits, SHA40))?.repo).toBe(
      "https://git.example.com/org/repo.git",
    );
  });

  it("does not let wildcard agentId override isolation", async () => {
    vi.stubEnv("AGENT_ID", "agent-b");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    kv.seed(KV.sessions, "s1", session({ id: "s1", agentId: "agent-a" }));
    const res = (await commit(
      postBody({ sha: SHA40, sessionId: "s1", agentId: "*" }),
    )) as { status_code: number };
    expect(res.status_code).toBe(403);
    expect(await kv.get<CommitLink>(KV.commits, SHA40)).toBeNull();
  });

  it("rejects an unknown session under isolation", async () => {
    vi.stubEnv("AGENT_ID", "agent-b");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const res = (await commit(
      postBody({ sha: SHA40, sessionId: "missing" }),
    )) as { status_code: number };
    expect(res.status_code).toBe(403);
    expect(await kv.get<CommitLink>(KV.commits, SHA40)).toBeNull();
    expect(await kv.get<Session>(KV.sessions, "missing")).toBeNull();
  });

  it("requires a sessionId under isolation", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");

    const res = (await commit(postBody({ sha: SHA40 }))) as {
      status_code: number;
    };

    expect(res.status_code).toBe(400);
    expect(await kv.get<CommitLink>(KV.commits, SHA40)).toBeNull();
  });

  it("regression: no env scope links freely across agent-tagged sessions", async () => {
    kv.seed(KV.sessions, "s1", session({ id: "s1", agentId: "agent-a" }));
    const res = (await commit(
      postBody({ sha: SHA40, sessionId: "s1" }),
    )) as { status_code: number };
    expect(res.status_code).toBe(200);
    expect(
      (await kv.get<Session>(KV.sessions, "s1"))?.commitShas,
    ).toEqual([SHA40]);
  });

  it("allows shared-mode ingest without a sessionId", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "shared");

    const res = (await commit(postBody({ sha: SHA40 }))) as {
      status_code: number;
      body: { commit: CommitLink };
    };

    expect(res.status_code).toBe(200);
    expect(res.body.commit.sessionIds).toEqual([]);
  });
});

describe("api::session::by-commit lookup", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let byCommit: Handler;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AGENT_ID", "");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "");
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    byCommit = sdk.getFunction("api::session::by-commit");
    kv.seed(KV.commits, SHA40, {
      sha: SHA40,
      shortSha: SHA40.slice(0, 7),
      message: "secret work",
      branch: "agent-b-private",
      repo: HTTPS_REPO,
      sessionIds: ["a-sess", "b-sess"],
      linkedAt: "2026-01-01T00:00:00.000Z",
    } satisfies CommitLink);
    kv.seed(KV.sessions, "a-sess", session({ id: "a-sess", agentId: "agent-a" }));
    kv.seed(KV.sessions, "b-sess", session({ id: "b-sess", agentId: "agent-b" }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns all sessions when no filter is active", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "shared");
    const res = (await byCommit(getReq({ sha: SHA40 }))) as {
      status_code: number;
      body: { sessions: Session[] };
    };
    expect(res.status_code).toBe(200);
    expect(res.body.sessions.map((s) => s.id).sort()).toEqual([
      "a-sess",
      "b-sess",
    ]);
  });

  it("projects legacy HTTPS credentials without rewriting by-commit storage", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "shared");
    const res = (await byCommit(getReq({ sha: SHA40 }))) as {
      body: { commit: CommitLink };
    };

    expect(res.body.commit.repo).toBe("https://git.example.com/org/repo.git");
    expect((await kv.get<CommitLink>(KV.commits, SHA40))?.repo).toBe(HTTPS_REPO);
  });

  it("normalizes uppercase SHAs and rejects malformed SHAs", async () => {
    const found = (await byCommit(
      getReq({ sha: SHA40.toUpperCase() }),
    )) as { status_code: number };
    expect(found.status_code).toBe(200);

    const invalid = (await byCommit(getReq({ sha: "abc123" }))) as {
      status_code: number;
    };
    expect(invalid.status_code).toBe(400);
  });

  it("filters commit session IDs with the query-param agentId", async () => {
    const res = (await byCommit(
      getReq({ sha: SHA40, agentId: "agent-a" }),
    )) as {
      status_code: number;
      body: { commit: CommitLink; sessions: Session[] };
    };
    expect(res.body.sessions.map((s) => s.id)).toEqual(["a-sess"]);
    expect(res.body.commit.sessionIds).toEqual(["a-sess"]);
  });

  it("404s under isolation when none of the linked sessions are visible", async () => {
    vi.stubEnv("AGENT_ID", "agent-c");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const res = (await byCommit(getReq({ sha: SHA40, agentId: "agent-a" }))) as {
      status_code: number;
    };
    expect(res.status_code).toBe(404);
  });

  it("shows only the caller's sessions under isolation", async () => {
    vi.stubEnv("AGENT_ID", "agent-b");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const res = (await byCommit(getReq({ sha: SHA40 }))) as {
      status_code: number;
      body: { commit: CommitLink; sessions: Session[] };
    };
    expect(res.body.sessions.map((s) => s.id)).toEqual(["b-sess"]);
    expect(res.body.commit.branch).toBeUndefined();
    expect(res.body.commit.repo).toBeUndefined();
  });

  it("fails closed under isolation without an agent identity", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const res = (await byCommit(getReq({ sha: SHA40, agentId: "agent-a" }))) as {
      status_code: number;
    };
    expect(res.status_code).toBe(404);
  });

  it("does not let wildcard agentId bypass env isolation", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const res = (await byCommit(
      getReq({ sha: SHA40, agentId: "*" }),
    )) as { status_code: number; body: { sessions: Session[] } };
    expect(res.status_code).toBe(200);
    expect(res.body.sessions.map((session) => session.id)).toEqual(["a-sess"]);
  });
});

describe("api::commits list", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let commits: Handler;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AGENT_ID", "");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "");
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    commits = sdk.getFunction("api::commits");
    kv.seed(KV.commits, SHA40, {
      sha: SHA40,
      shortSha: SHA40.slice(0, 7),
      branch: "agent-b-private",
      repo: HTTPS_REPO,
      sessionIds: ["a-sess", "b-sess"],
      linkedAt: "2026-01-02T00:00:00.000Z",
    } satisfies CommitLink);
    kv.seed(KV.commits, SHA64, {
      sha: SHA64,
      shortSha: SHA64.slice(0, 7),
      repo: SCP_REPO,
      sessionIds: ["b-sess"],
      linkedAt: "2026-01-01T00:00:00.000Z",
    } satisfies CommitLink);
    kv.seed(KV.sessions, "a-sess", session({ id: "a-sess", agentId: "agent-a" }));
    kv.seed(KV.sessions, "b-sess", session({ id: "b-sess", agentId: "agent-b" }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists all commits when no filter is active", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "shared");
    const res = (await commits(getReq({}))) as {
      body: { commits: CommitLink[] };
    };
    expect(res.body.commits.map((c) => c.sha).sort()).toEqual(
      [SHA40, SHA64].sort(),
    );
  });

  it.each(REPO_FILTER_CASES)(
    "matches %s repo filters without exposing credentials",
    async (_label, sha, repo, storedRepo, expectedRepo) => {
      const existing = await kv.get<CommitLink>(KV.commits, sha);
      if (!existing) throw new Error("seeded commit was not found");
      kv.seed(KV.commits, sha, { ...existing, repo: storedRepo });
      const otherSha = sha === SHA40 ? SHA64 : SHA40;
      const other = await kv.get<CommitLink>(KV.commits, otherSha);
      if (!other) throw new Error("other seeded commit was not found");
      kv.seed(KV.commits, otherSha, {
        ...other,
        repo: "https://git.example.com/other/repo.git",
      });

      const res = (await commits(getReq({ repo }))) as {
        body: { commits: CommitLink[] };
      };

      expect(res.body.commits.map((commit) => commit.sha)).toEqual([sha]);
      expect(res.body.commits[0]?.repo).toBe(expectedRepo);
      expect((await kv.get<CommitLink>(KV.commits, sha))?.repo).toBe(storedRepo);
    },
  );

  it("projects legacy credentials without rewriting listed commit storage", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "shared");
    const res = (await commits(getReq({}))) as {
      body: { commits: CommitLink[] };
    };

    expect(res.body.commits.find((commit) => commit.sha === SHA40)?.repo).toBe(
      "https://git.example.com/org/repo.git",
    );
    expect(res.body.commits.find((commit) => commit.sha === SHA64)?.repo).toBe(
      "git.example.com:org/repo.git",
    );
    expect((await kv.get<CommitLink>(KV.commits, SHA40))?.repo).toBe(HTTPS_REPO);
    expect((await kv.get<CommitLink>(KV.commits, SHA64))?.repo).toBe(SCP_REPO);
  });

  it("only shows commits with a session visible to the caller (isolated)", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const res = (await commits(getReq({ agentId: "agent-a" }))) as {
      body: { commits: CommitLink[] };
    };
    expect(res.body.commits.map((c) => c.sha)).toEqual([SHA40]);
    expect(res.body.commits[0]?.branch).toBeUndefined();
    expect(res.body.commits[0]?.repo).toBeUndefined();
  });

  it("returns no commits under isolation without an agent identity", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const res = (await commits(getReq({ agentId: "agent-a" }))) as {
      body: { commits: CommitLink[] };
    };
    expect(res.body.commits).toEqual([]);
  });

  it("returns no commits when the caller owns none (isolated)", async () => {
    vi.stubEnv("AGENT_ID", "agent-z");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const res = (await commits(getReq({}))) as {
      body: { commits: CommitLink[] };
    };
    expect(res.body.commits).toHaveLength(0);
  });

  it("does not let wildcard agentId bypass env isolation", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const res = (await commits(getReq({ agentId: "*" }))) as {
      body: { commits: CommitLink[] };
    };
    expect(res.body.commits).toHaveLength(1);
    expect(res.body.commits[0]?.sessionIds).toEqual(["a-sess"]);
  });
});

describe("MCP memory_commit_lookup / memory_commits isolation", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let call: Handler;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AGENT_ID", "");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "");
    sdk = mockSdk();
    kv = mockKV();
    registerMcpEndpoints(sdk as never, kv as never, undefined);
    call = sdk.getFunction("mcp::tools::call");
    kv.seed(KV.commits, SHA40, {
      sha: SHA40,
      shortSha: SHA40.slice(0, 7),
      branch: "agent-b-private",
      repo: SCP_REPO,
      sessionIds: ["a-sess", "b-sess"],
      linkedAt: "2026-01-02T00:00:00.000Z",
    } satisfies CommitLink);
    kv.seed(KV.commits, SHA64, {
      sha: SHA64,
      shortSha: SHA64.slice(0, 7),
      repo: HTTPS_REPO,
      sessionIds: ["b-sess"],
      linkedAt: "2026-01-01T00:00:00.000Z",
    } satisfies CommitLink);
    kv.seed(KV.sessions, "a-sess", session({ id: "a-sess", agentId: "agent-a" }));
    kv.seed(KV.sessions, "b-sess", session({ id: "b-sess", agentId: "agent-b" }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("commit_lookup returns the commit + sessions with no filter", async () => {
    const { parsed } = await mcpCall(call, "memory_commit_lookup", {
      sha: SHA40,
    });
    expect((parsed.commit as CommitLink).sha).toBe(SHA40);
    expect((parsed.sessions as Session[]).map((s) => s.id)).toEqual([
      "a-sess",
      "b-sess",
    ]);
  });

  it("commit_lookup projects legacy SCP credentials without rewriting storage", async () => {
    const { parsed } = await mcpCall(call, "memory_commit_lookup", {
      sha: SHA40,
    });

    expect((parsed.commit as CommitLink).repo).toBe("git.example.com:org/repo.git");
    expect((await kv.get<CommitLink>(KV.commits, SHA40))?.repo).toBe(SCP_REPO);
  });

  it("commit_lookup normalizes uppercase SHAs and rejects malformed SHAs", async () => {
    const found = await mcpCall(call, "memory_commit_lookup", {
      sha: SHA40.toUpperCase(),
    });
    expect((found.parsed.commit as CommitLink).sha).toBe(SHA40);

    const invalid = await mcpCall(call, "memory_commit_lookup", {
      sha: "abc123",
    });
    expect(invalid.res.status_code).toBe(400);
  });

  it("commit_lookup hides another agent's commit under isolation", async () => {
    vi.stubEnv("AGENT_ID", "agent-c");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const { parsed } = await mcpCall(call, "memory_commit_lookup", {
      sha: SHA40,
    });
    expect(parsed.commit).toBeNull();
    expect(parsed.sessions).toEqual([]);
  });

  it("commit_lookup fails closed under isolation without an agent identity", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const { parsed } = await mcpCall(call, "memory_commit_lookup", {
      sha: SHA40,
      agentId: "agent-a",
    });
    expect(parsed.commit).toBeNull();
    expect(parsed.sessions).toEqual([]);
  });

  it("commit_lookup returns no retained foreign metadata for the active agent", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");

    const { parsed } = await mcpCall(call, "memory_commit_lookup", {
      sha: SHA64,
    });

    expect(parsed.commit).toBeNull();
    expect(parsed.sessions).toEqual([]);
  });

  it("does not let commit_lookup wildcard agentId bypass isolation", async () => {
    vi.stubEnv("AGENT_ID", "agent-b");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const { parsed } = await mcpCall(call, "memory_commit_lookup", {
      sha: SHA40,
      agentId: "*",
    });
    expect((parsed.commit as CommitLink).sessionIds).toEqual(["b-sess"]);
    expect((parsed.commit as CommitLink).branch).toBeUndefined();
    expect((parsed.commit as CommitLink).repo).toBeUndefined();
  });

  it("commits lists only the caller's commits under isolation", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const { parsed } = await mcpCall(call, "memory_commits", { agentId: "agent-a" });
    expect((parsed.commits as CommitLink[]).map((c) => c.sha)).toEqual([SHA40]);
    expect((parsed.commits as CommitLink[])[0]?.sessionIds).toEqual(["a-sess"]);
    expect((parsed.commits as CommitLink[])[0]?.branch).toBeUndefined();
    expect((parsed.commits as CommitLink[])[0]?.repo).toBeUndefined();
  });

  it("commits returns no results under isolation without an agent identity", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const { parsed } = await mcpCall(call, "memory_commits", { agentId: "agent-a" });
    expect(parsed.commits).toEqual([]);
  });

  it("commits regression: no scope lists everything", async () => {
    const { parsed } = await mcpCall(call, "memory_commits", {});
    expect((parsed.commits as CommitLink[]).length).toBe(2);
  });

  it.each(REPO_FILTER_CASES)(
    "commits matches %s repo filters without exposing credentials",
    async (_label, sha, repo, storedRepo, expectedRepo) => {
      const existing = await kv.get<CommitLink>(KV.commits, sha);
      if (!existing) throw new Error("seeded commit was not found");
      kv.seed(KV.commits, sha, { ...existing, repo: storedRepo });
      const otherSha = sha === SHA40 ? SHA64 : SHA40;
      const other = await kv.get<CommitLink>(KV.commits, otherSha);
      if (!other) throw new Error("other seeded commit was not found");
      kv.seed(KV.commits, otherSha, {
        ...other,
        repo: "https://git.example.com/other/repo.git",
      });

      const { parsed } = await mcpCall(call, "memory_commits", { repo });
      const commits = parsed.commits as CommitLink[];

      expect(commits.map((commit) => commit.sha)).toEqual([sha]);
      expect(commits[0]?.repo).toBe(expectedRepo);
      expect((await kv.get<CommitLink>(KV.commits, sha))?.repo).toBe(storedRepo);
    },
  );

  it("commits projects legacy credentials without rewriting storage", async () => {
    const { parsed } = await mcpCall(call, "memory_commits", {});
    const commits = parsed.commits as CommitLink[];

    expect(commits.find((commit) => commit.sha === SHA40)?.repo).toBe(
      "git.example.com:org/repo.git",
    );
    expect(commits.find((commit) => commit.sha === SHA64)?.repo).toBe(
      "https://git.example.com/org/repo.git",
    );
    expect((await kv.get<CommitLink>(KV.commits, SHA40))?.repo).toBe(SCP_REPO);
    expect((await kv.get<CommitLink>(KV.commits, SHA64))?.repo).toBe(HTTPS_REPO);
  });
});
