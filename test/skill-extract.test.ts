import { describe, it, expect, vi, beforeEach } from "vitest";

const mockKv = {
  get: vi.fn(),
  set: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
};

const mockSdk = {
  registerFunction: vi.fn(),
};

const mockProvider = {
  name: "test",
  compress: vi.fn(),
  summarize: vi.fn(),
};

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/audit.js", () => ({
  recordAudit: vi.fn(),
}));

import { registerSkillExtractFunctions } from "../src/functions/skill-extract.js";

describe("skill-extract", () => {
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKv.get.mockResolvedValue(null);
    mockKv.set.mockResolvedValue(undefined);
    mockKv.list.mockResolvedValue([]);

    handlers = {};
    mockSdk.registerFunction.mockImplementation((idOrMeta: any, handler: any) => {
      const id = typeof idOrMeta === "string" ? idOrMeta : idOrMeta.id;
      handlers[id] = handler;
    });

    registerSkillExtractFunctions(mockSdk as any, mockKv as any, mockProvider);
  });

  it("registers all skill functions", () => {
    expect(handlers["mem::skill-extract"]).toBeDefined();
    expect(handlers["mem::skill-list"]).toBeDefined();
    expect(handlers["mem::skill-match"]).toBeDefined();
  });

  it("skill-extract requires sessionId", async () => {
    const result = await handlers["mem::skill-extract"]({});
    expect(result.success).toBe(false);
  });

  it("skill-extract returns error for missing session", async () => {
    mockKv.get.mockReturnValue(Promise.resolve(null));
    const result = await handlers["mem::skill-extract"]({
      sessionId: "nonexistent",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("session not found");
  });

  it("skill-extract parses LLM response into ProceduralMemory", async () => {
    mockKv.get.mockImplementation((scope: string, key: string) => {
      if (scope === "mem:sessions")
        return Promise.resolve({ id: "s1", project: "test", status: "completed" });
      if (scope === "mem:summaries")
        return Promise.resolve({
          sessionId: "s1",
          project: "test",
          title: "Fix auth bug",
          narrative: "Debugged and fixed JWT expiration",
          keyDecisions: ["Switch to RS256"],
          filesModified: ["auth.ts"],
          concepts: ["authentication", "JWT"],
          createdAt: new Date().toISOString(),
          observationCount: 10,
        });
      return Promise.resolve(null);
    });

    mockKv.list.mockReturnValue(
      Promise.resolve(Array.from({ length: 5 }, (_, i) => ({
        id: `obs${i}`,
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        type: "file_edit",
        title: `Edit auth.ts step ${i}`,
        narrative: `Modified JWT validation logic step ${i}`,
        importance: 7,
        concepts: ["JWT"],
        files: ["auth.ts"],
        facts: [],
      }))),
    );

    mockProvider.summarize.mockResolvedValue(`
<skill>
<trigger>When the agent encounters JWT authentication failures or token expiration issues</trigger>
<title>Fix JWT Token Expiration</title>
<steps>
<step>Check the JWT library configuration for clock skew tolerance</step>
<step>Verify the signing algorithm matches between issuer and verifier</step>
<step>Update token expiration to use RS256 with proper key rotation</step>
</steps>
<expected_outcome>JWT auth works reliably with proper expiration handling</expected_outcome>
<tags>jwt,authentication,security</tags>
</skill>
    `);

    const result = await handlers["mem::skill-extract"]({ sessionId: "s1" });
    expect(result.success).toBe(true);
    expect(result.extracted).toBe(true);
    expect(result.skill.name).toBe("Fix JWT Token Expiration");
    expect(result.skill.steps).toHaveLength(3);
    expect(result.skill.triggerCondition).toContain("JWT");
    expect(mockKv.set).toHaveBeenCalled();
  });

  it("skill-extract returns no-skill for exploratory sessions", async () => {
    mockKv.get.mockImplementation((scope: string) => {
      if (scope === "mem:sessions") return Promise.resolve({ id: "s1", project: "test", status: "completed" });
      if (scope === "mem:summaries")
        return Promise.resolve({
          sessionId: "s1",
          project: "test",
          title: "Explore codebase",
          narrative: "Browsed files",
          keyDecisions: [],
          filesModified: [],
          concepts: [],
          createdAt: new Date().toISOString(),
          observationCount: 3,
        });
      return Promise.resolve(null);
    });
    mockKv.list.mockReturnValue(
      Promise.resolve(Array.from({ length: 4 }, (_, i) => ({
        id: `obs${i}`,
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        type: "file_read",
        title: `Read file ${i}`,
        importance: 5,
        concepts: [],
        files: [],
        facts: [],
        narrative: "",
      }))),
    );
    mockProvider.summarize.mockResolvedValue("<no-skill/>");

    const result = await handlers["mem::skill-extract"]({ sessionId: "s1" });
    expect(result.success).toBe(true);
    expect(result.extracted).toBe(false);
  });

  it("skill-list returns sorted by strength", async () => {
    mockKv.list.mockResolvedValue([
      { id: "s1", name: "Low", strength: 0.3 },
      { id: "s2", name: "High", strength: 0.9 },
    ]);
    const result = await handlers["mem::skill-list"]({});
    expect(result.skills[0].name).toBe("High");
  });

  it("skill-match finds relevant skills", async () => {
    mockKv.list.mockResolvedValue([
      {
        id: "s1",
        name: "Fix JWT Auth",
        triggerCondition: "JWT failures",
        tags: ["jwt", "auth"],
        steps: ["check config", "update key"],
        strength: 0.8,
      },
      {
        id: "s2",
        name: "Deploy Docker",
        triggerCondition: "container deployment",
        tags: ["docker", "deploy"],
        steps: ["build image", "push"],
        strength: 0.7,
      },
    ]);

    const result = await handlers["mem::skill-match"]({
      query: "JWT authentication token expired",
    });
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].skill.name).toBe("Fix JWT Auth");
  });
});

describe("skill-extract uncheckpointed activity guard (Option K)", () => {
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKv.get.mockResolvedValue(null);
    mockKv.set.mockResolvedValue(undefined);
    mockKv.list.mockResolvedValue([]);

    handlers = {};
    mockSdk.registerFunction.mockImplementation((idOrMeta: any, handler: any) => {
      const id = typeof idOrMeta === "string" ? idOrMeta : idOrMeta.id;
      handlers[id] = handler;
    });

    registerSkillExtractFunctions(mockSdk as any, mockKv as any, mockProvider);
  });

  it("rejects extraction when session.updatedAt is past the watermark", async () => {
    mockKv.get.mockImplementation((scope: string) => {
      if (scope === "mem:sessions") return Promise.resolve({
        id: "s_uncheckpointed",
        project: "test",
        status: "completed",
        endedAt: "2026-01-01T10:00:00.000Z",
        lastCheckpointAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T15:00:00.000Z",
      });
      return Promise.resolve(null);
    });

    const result = await handlers["mem::skill-extract"]({ sessionId: "s_uncheckpointed" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/uncheckpointed|checkpoint/i);
  });

  it("allows extraction when updatedAt <= watermark (fully consolidated)", async () => {
    mockKv.get.mockImplementation((scope: string) => {
      if (scope === "mem:sessions") return Promise.resolve({
        id: "s_clean",
        project: "test",
        status: "completed",
        endedAt: "2026-01-01T15:00:00.000Z",
        lastCheckpointAt: "2026-01-01T15:00:00.000Z",
        updatedAt: "2026-01-01T15:00:00.000Z",
      });
      if (scope === "mem:summaries") return Promise.resolve({
        sessionId: "s_clean",
        project: "test",
        title: "Done",
        narrative: "work done",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        createdAt: "2026-01-01T15:00:00.000Z",
        observationCount: 5,
      });
      return Promise.resolve(null);
    });
    mockKv.list.mockResolvedValue([
      { id: "o1", sessionId: "s_clean", timestamp: "2026-01-01T11:00:00Z", type: "file_edit", title: "e1", narrative: "n", importance: 7, concepts: [], files: [], facts: [] },
      { id: "o2", sessionId: "s_clean", timestamp: "2026-01-01T12:00:00Z", type: "file_edit", title: "e2", narrative: "n", importance: 7, concepts: [], files: [], facts: [] },
      { id: "o3", sessionId: "s_clean", timestamp: "2026-01-01T13:00:00Z", type: "file_edit", title: "e3", narrative: "n", importance: 7, concepts: [], files: [], facts: [] },
    ]);
    mockProvider.summarize.mockResolvedValue("<no-skill/>");

    const result = await handlers["mem::skill-extract"]({ sessionId: "s_clean" });
    expect(result.success).toBe(true);
  });
});
