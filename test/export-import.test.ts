import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { getSearchIndex } from "../src/functions/search.js";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ExportData,
  RawObservation,
  GraphNode,
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
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const testSession: Session = {
  id: "ses_1",
  project: "my-project",
  cwd: "/tmp",
  startedAt: "2026-02-01T00:00:00Z",
  status: "completed",
  observationCount: 1,
};

const testObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  sourceType: "post_tool_use",
  type: "file_edit",
  title: "Edit auth",
  facts: ["Added check"],
  narrative: "Auth changes",
  concepts: ["auth"],
  files: ["src/auth.ts"],
  importance: 7,
};

const testRawPayload: RawObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  hookType: "post_tool_use",
  toolName: "Edit",
  toolInput: { file_path: "src/auth.ts" },
  raw: { tool_name: "Edit" },
};

const testMemory: Memory = {
  id: "mem_1",
  createdAt: "2026-02-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
  type: "pattern",
  title: "Auth pattern",
  content: "Always validate tokens",
  concepts: ["auth"],
  files: [],
  sessionIds: ["ses_1"],
  strength: 5,
  version: 1,
  isLatest: true,
};

const testSummary: SessionSummary = {
  sessionId: "ses_1",
  project: "my-project",
  createdAt: "2026-02-01T00:00:00Z",
  title: "Auth work",
  narrative: "Worked on auth",
  keyDecisions: ["Use JWT"],
  filesModified: ["src/auth.ts"],
  concepts: ["auth"],
  observationCount: 1,
};

describe("Export/Import Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerExportImportFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_1", testSession);
    await kv.set("mem:obs:ses_1", "obs_1", testObs);
    await kv.set("mem:raw-payloads", "obs_1", testRawPayload);
    await kv.set("mem:memories", "mem_1", testMemory);
    await kv.set("mem:summaries", "ses_1", testSummary);
  });

  it("export produces valid ExportData structure", async () => {
    const result = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(result.version).toBe("0.9.27");
    expect(result.exportedAt).toBeDefined();
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe("ses_1");
    expect(result.observations["ses_1"].length).toBe(1);
    expect(result.rawPayloads).toEqual([testRawPayload]);
    expect(result.memories.length).toBe(1);
    expect(result.summaries.length).toBe(1);
  });

  it("import with merge strategy adds data", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_2", observationCount: 0 }],
      observations: {},
      memories: [{ ...testMemory, id: "mem_2", title: "New pattern" }],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; sessions: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);
    expect(result.memories).toBe(1);

    const allSessions = await kv.list("mem:sessions");
    expect(allSessions.length).toBe(2);
  });

  it("import with skip strategy does not overwrite existing", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [testSession],
      observations: { ses_1: [testObs] },
      memories: [testMemory],
      summaries: [testSummary],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "skip",
    })) as { success: boolean; skipped: number; sessions: number };

    expect(result.success).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sessions).toBe(0);
  });

  it("import with replace strategy clears existing data first", async () => {
    const newSession: Session = {
      id: "ses_new",
      project: "new-project",
      cwd: "/tmp/new",
      startedAt: "2026-03-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    };
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [newSession],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; sessions: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);

    const oldSession = await kv.get("mem:sessions", "ses_1");
    expect(oldSession).toBeNull();
  });

  it.each([
    {
      name: "has another page",
      pagination: { offset: 0, limit: 1, total: 2, hasMore: true },
    },
    {
      name: "starts after the first session",
      pagination: { offset: 1, limit: 1, total: 2, hasMore: false },
    },
    {
      name: "reports more sessions than it contains",
      pagination: { offset: 0, limit: 2, total: 2, hasMore: false },
    },
  ])("rejects a partial replace export that $name", async ({ pagination }) => {
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_partial" }],
      observations: {},
      memories: [],
      summaries: [],
      pagination,
    };
    const list = vi.spyOn(kv, "list");

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; error: string };

    expect(result).toEqual({
      success: false,
      error: "replace requires an export containing all sessions",
    });
    expect(list).not.toHaveBeenCalled();
    expect(await kv.get("mem:sessions", "ses_1")).toEqual(testSession);
  });

  it("accepts a paginated replace export that contains every session", async () => {
    const newSession = { ...testSession, id: "ses_complete" };
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [newSession],
      observations: {},
      memories: [],
      summaries: [],
      pagination: { offset: 0, limit: 1, total: 1, hasMore: false },
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(await kv.get("mem:sessions", "ses_complete")).toEqual(newSession);
    expect(await kv.get("mem:sessions", "ses_1")).toBeNull();
  });

  it("rebuilds the search index after import", async () => {
    getSearchIndex().add(testObs);
    const importedMemory = {
      ...testMemory,
      id: "mem_imported",
      title: "Imported search entry",
    };
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [importedMemory],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; indexEntries: number };

    expect(result).toMatchObject({ success: true, indexEntries: 1 });
    expect(getSearchIndex().has(testObs.id)).toBe(false);
    expect(getSearchIndex().has(importedMemory.id)).toBe(true);
  });

  it("export then import round-trip preserves data", async () => {
    const exported = (await sdk.trigger("mem::export", {})) as ExportData;

    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const importResult = (await freshSdk.trigger("mem::import", {
      exportData: exported,
      strategy: "merge",
    })) as {
      success: boolean;
      sessions: number;
      observations: number;
      rawPayloads: number;
      memories: number;
    };

    expect(importResult.success).toBe(true);
    expect(importResult.sessions).toBe(1);
    expect(importResult.observations).toBe(1);
    expect(importResult.rawPayloads).toBe(1);
    expect(importResult.memories).toBe(1);

    const reExported = (await freshSdk.trigger(
      "mem::export",
      {},
    )) as ExportData;
    expect(reExported.sessions.length).toBe(exported.sessions.length);
    expect(reExported.memories.length).toBe(exported.memories.length);
    expect(reExported.rawPayloads).toEqual(exported.rawPayloads);
  });

  it("import rejects unsupported version", async () => {
    const exportData = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported export version");
  });

  it("fails export instead of returning an incomplete backup", async () => {
    const originalList = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (scope === "mem:raw-payloads") throw new Error("raw read failed");
      return originalList<T>(scope);
    };

    await expect(sdk.trigger("mem::export", {})).rejects.toThrow(
      "raw read failed",
    );
  });

  it("preflights replace reads before deleting existing data", async () => {
    const originalList = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (scope === "mem:raw-payloads") throw new Error("raw read failed");
      return originalList<T>(scope);
    };
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    };

    await expect(
      sdk.trigger("mem::import", { exportData, strategy: "replace" }),
    ).rejects.toThrow("raw read failed");
    expect(await kv.get("mem:sessions", "ses_1")).toEqual(testSession);
  });

  it("rejects malformed optional collections before replace deletes data", async () => {
    const exportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      graphNodes: [null],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("graphNodes[0]");
    expect(await kv.get("mem:sessions", "ses_1")).toEqual(testSession);
  });

  it("rejects observations stored under a different session bucket", async () => {
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: { wrong_session: [testObs] },
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("mismatched sessionId");
    expect(await kv.get("mem:sessions", "ses_1")).toEqual(testSession);
  });

  it("rebuilds image reference counts without double-counting one observation", async () => {
    const imagePath = "/managed/image.png";
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [testSession],
      observations: {
        ses_1: [{ ...testObs, imageData: imagePath, imageRef: imagePath }],
      },
      rawPayloads: [{ ...testRawPayload, imageData: imagePath }],
      memories: [{ ...testMemory, imageRef: imagePath }],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; imageRefs: number };

    expect(result.success).toBe(true);
    expect(result.imageRefs).toBe(1);
    expect(await kv.get("mem:image-refs", imagePath)).toBe(2);
  });

  it("removes image reference counts orphaned by merge overwrites", async () => {
    await kv.set("mem:memories", "mem_1", {
      ...testMemory,
      imageRef: "/managed/old.png",
    });
    await kv.set("mem:image-refs", "/managed/old.png", 1);
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [{ ...testMemory, imageRef: "/managed/new.png" }],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(await kv.get("mem:image-refs", "/managed/old.png")).toBeNull();
    expect(await kv.get("mem:image-refs", "/managed/new.png")).toBe(1);
  });

  it("rebuilds graph snapshot and lookup indexes after import", async () => {
    const node = {
      id: "node_1",
      type: "file",
      name: "src/auth.ts",
      properties: {},
      sourceObservationIds: ["obs_1"],
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    };
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      graphNodes: [node as GraphNode],
      graphEdges: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(await kv.get("mem:graph:name-index", "file|src/auth.ts")).toBe(
      "node_1",
    );
    expect(await kv.get("mem:graph:snapshot", "current")).toMatchObject({
      stats: { totalNodes: 1, totalEdges: 0 },
    });
  });

  it("removes stale graph indexes and tombstones during merge", async () => {
    const existingNode: GraphNode = {
      id: "node_1",
      type: "file",
      name: "src/old.ts",
      properties: {},
      sourceObservationIds: ["obs_1"],
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    };
    await kv.set("mem:graph:nodes", existingNode.id, existingNode);
    await kv.set("mem:graph:name-index", "file|src/old.ts", existingNode.id);
    await kv.set("mem:graph:tombstones", existingNode.id, {
      id: existingNode.id,
      kind: "node",
    });
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      graphNodes: [{ ...existingNode, name: "src/new.ts" }],
      graphEdges: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(await kv.get("mem:graph:name-index", "file|src/old.ts")).toBeNull();
    expect(await kv.get("mem:graph:name-index", "file|src/new.ts")).toBe(
      "node_1",
    );
    expect(await kv.get("mem:graph:tombstones", "node_1")).toBeNull();
  });
});
