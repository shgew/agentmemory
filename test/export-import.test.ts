import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare function setImmediate(callback: () => void): void;

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/utils/image-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/image-store.js")>();
  return { ...actual, deleteImage: vi.fn(async () => ({ deletedBytes: 0 })) };
});

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { registerCompressFunction } from "../src/functions/compress.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import {
  deleteImageBackedRecord,
  withObservationSessionOwnerLock,
} from "../src/functions/image-owner.js";
import {
  getSearchIndex,
  getVectorIndex,
  rebuildIndex,
  setEmbeddingProvider,
  setIndexPersistence,
  setVectorIndex,
} from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { deleteImage } from "../src/utils/image-store.js";
import { logger } from "../src/logger.js";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ExportData,
  RawObservation,
  GraphNode,
  MemoryProvider,
} from "../src/types.js";

const validCompression = `<type>other</type>
<title>Stale compression</title>
<facts><fact>Compressed before import</fact></facts>
<narrative>Stale compression completed.</narrative>
<concepts><concept>import</concept></concepts>
<files></files>
<importance>5</importance>`;

function blockingCompressionProvider() {
  let release = () => {};
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: MemoryProvider = {
    name: "test",
    compress: async () => {
      markStarted();
      await blocked;
      return validCompression;
    },
    summarize: async () => "",
  };
  return { provider, started, release: () => release() };
}

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
    update: async <T>(
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ): Promise<T> => {
      const entry = store.get(scope)?.get(key);
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Cannot update missing record: ${scope}/${key}`);
      }
      const updated: Record<string, unknown> = { ...entry };
      for (const operation of ops) {
        if (operation.type !== "set") {
          throw new Error(`Unsupported update operation: ${operation.type}`);
        }
        updated[operation.path] = operation.value;
      }
      store.get(scope)!.set(key, updated);
      return updated as T;
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
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: Function,
    ) => {
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
    vi.stubEnv("AGENT_ID", "");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "");
    sdk = mockSdk();
    kv = mockKV();
    registerExportImportFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_1", testSession);
    await kv.set("mem:obs:ses_1", "obs_1", testObs);
    await kv.set("mem:raw-payloads", "obs_1", testRawPayload);
    await kv.set("mem:memories", "mem_1", testMemory);
    await kv.set("mem:summaries", "ses_1", testSummary);
  });

  afterEach(() => {
    setIndexPersistence(null);
    setVectorIndex(null);
    setEmbeddingProvider(null);
    vi.unstubAllEnvs();
  });

  it("export produces valid ExportData structure", async () => {
    const result = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(result.version).toBe("0.9.28");
    expect(result.exportedAt).toBeDefined();
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe("ses_1");
    expect(result.observations["ses_1"].length).toBe(1);
    expect(result.rawPayloads).toEqual([testRawPayload]);
    expect(result.memories.length).toBe(1);
    expect(result.summaries.length).toBe(1);
  });

  it("isolated export excludes another agent's rows", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const agentASession = { ...testSession, id: "ses_agent_a", agentId: "agent-a" };
    const agentBSession = { ...testSession, id: "ses_agent_b", agentId: "agent-b" };
    const agentAObservation = {
      ...testObs,
      id: "obs_agent_a",
      sessionId: agentASession.id,
      agentId: "agent-a",
    };
    const agentBObservation = {
      ...testObs,
      id: "obs_agent_b",
      sessionId: agentBSession.id,
      agentId: "agent-b",
    };
    await kv.set(KV.sessions, agentASession.id, agentASession);
    await kv.set(KV.sessions, agentBSession.id, agentBSession);
    await kv.set(
      KV.observations(agentASession.id),
      agentAObservation.id,
      agentAObservation,
    );
    await kv.set(
      KV.observations(agentBSession.id),
      agentBObservation.id,
      agentBObservation,
    );
    await kv.set(KV.memories, "mem_agent_a", {
      ...testMemory,
      id: "mem_agent_a",
      agentId: "agent-a",
    });
    await kv.set(KV.memories, "mem_agent_b", {
      ...testMemory,
      id: "mem_agent_b",
      agentId: "agent-b",
    });
    await kv.set(KV.semantic, "sem_agent_b", { id: "sem_agent_b" });
    await kv.set(KV.accessLog, "sem_agent_b", {
      memoryId: "sem_agent_b",
      count: 1,
      lastAt: "2026-02-01T00:00:00Z",
      recent: [1],
    });

    const result = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(result.sessions).toEqual([agentASession]);
    expect(result.observations).toEqual({
      [agentASession.id]: [agentAObservation],
    });
    expect(result.memories).toEqual([
      { ...testMemory, id: "mem_agent_a", agentId: "agent-a" },
    ]);
    expect(result.semanticMemories).toBeUndefined();
    expect(result.accessLogs).toBeUndefined();
  });

  it("isolated export rejects missing agent identity", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");

    await expect(sdk.trigger("mem::export", {})).rejects.toThrow(
      "mem::export: AGENTMEMORY_AGENT_SCOPE=isolated requires AGENT_ID",
    );
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

  it("isolated import cannot overwrite another agent's memory", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const agentBMemory = {
      ...testMemory,
      id: "mem_agent_b",
      content: "Agent B private memory",
      agentId: "agent-b",
    };
    await kv.set(KV.memories, agentBMemory.id, agentBMemory);

    const result = (await sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: {},
        memories: [{ ...agentBMemory, agentId: "agent-a" }],
        summaries: [],
      } satisfies ExportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(await kv.get(KV.memories, agentBMemory.id)).toEqual(agentBMemory);
  });

  it("isolated replace cannot delete another agent's rows", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    const agentASession = { ...testSession, id: "ses_agent_a", agentId: "agent-a" };
    const agentBSession = { ...testSession, id: "ses_agent_b", agentId: "agent-b" };
    await kv.set(KV.sessions, agentASession.id, agentASession);
    await kv.set(KV.sessions, agentBSession.id, agentBSession);

    const result = (await sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: {},
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "replace",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(await kv.get(KV.sessions, agentASession.id)).toBeNull();
    expect(await kv.get(KV.sessions, agentBSession.id)).toEqual(agentBSession);
  });

  it("isolated replace rejects missing agent identity before deleting data", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");

    await expect(
      sdk.trigger("mem::import", {
        exportData: {
          version: "0.9.27",
          exportedAt: new Date().toISOString(),
          sessions: [],
          observations: {},
          memories: [],
          summaries: [],
        } satisfies ExportData,
        strategy: "replace",
      }),
    ).rejects.toThrow(
      "mem::import: AGENTMEMORY_AGENT_SCOPE=isolated requires AGENT_ID",
    );
    expect(await kv.get(KV.sessions, testSession.id)).toEqual(testSession);
    expect(await kv.get(KV.memories, testMemory.id)).toEqual(testMemory);
  });

  it("replace removes raw payload session indexes", async () => {
    await kv.set(
      KV.rawPayloadsBySession(testRawPayload.sessionId),
      testRawPayload.id,
      { id: testRawPayload.id, sessionId: testRawPayload.sessionId },
    );

    const result = (await sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: {},
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "replace",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(
      await kv.list(KV.rawPayloadsBySession(testRawPayload.sessionId)),
    ).toEqual([]);
  });

  it("replace restores prior state after an imported write fails", async () => {
    const setRecord = kv.set;
    let failImportedSessionWrite = true;
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (
        failImportedSessionWrite &&
        scope === KV.sessions &&
        key === "ses_replace_failure"
      ) {
        failImportedSessionWrite = false;
        throw new Error("injected import write failure");
      }
      return setRecord(scope, key, value);
    });

    await expect(
      sdk.trigger("mem::import", {
        exportData: {
          version: "0.9.27",
          exportedAt: new Date().toISOString(),
          sessions: [{ ...testSession, id: "ses_replace_failure" }],
          observations: {},
          memories: [],
          summaries: [],
        } satisfies ExportData,
        strategy: "replace",
      }),
    ).rejects.toThrow("injected import write failure");

    expect(await kv.get(KV.sessions, testSession.id)).toEqual(testSession);
    expect(await kv.get(KV.memories, testMemory.id)).toEqual(testMemory);
    expect(await kv.get(KV.sessions, "ses_replace_failure")).toBeNull();
  });

  it("replace rollback preserves a concurrent unrelated write", async () => {
    const setRecord = kv.set;
    let releaseImportedWrite = () => {};
    const importedWriteBlocked = new Promise<void>((resolve) => {
      releaseImportedWrite = resolve;
    });
    let markImportedWriteStarted = () => {};
    const importedWriteStarted = new Promise<void>((resolve) => {
      markImportedWriteStarted = resolve;
    });
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (scope === KV.sessions && key === "ses_concurrent_rollback") {
        markImportedWriteStarted();
        await importedWriteBlocked;
        throw new Error("injected import write failure");
      }
      return setRecord(scope, key, value);
    });

    const importing = sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [{ ...testSession, id: "ses_concurrent_rollback" }],
        observations: {},
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "replace",
    });
    await importedWriteStarted;
    const unrelated = { value: "preserve me" };
    await kv.set(KV.config, "unrelated", unrelated);
    releaseImportedWrite();

    await expect(importing).rejects.toThrow("injected import write failure");
    expect(await kv.get(KV.config, "unrelated")).toEqual(unrelated);
  });

  it("restores live and persisted indexes when replace audit fails", async () => {
    const importedMemory = {
      ...testMemory,
      id: "mem_replace_index",
      title: "Replacement memory",
      content: "Replacement content",
    };
    getSearchIndex().clear();
    await rebuildIndex(kv as never);
    const persistedStates: Array<{ original: boolean; replacement: boolean }> = [];
    setIndexPersistence({
      scheduleSave: vi.fn(),
      save: vi.fn(async () => {
        persistedStates.push({
          original: getSearchIndex().has(testMemory.id),
          replacement: getSearchIndex().has(importedMemory.id),
        });
      }),
      saveStrict: vi.fn(async () => {
        persistedStates.push({
          original: getSearchIndex().has(testMemory.id),
          replacement: getSearchIndex().has(importedMemory.id),
        });
      }),
    });
    const setRecord = kv.set;
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (scope === KV.audit) throw new Error("injected audit write failure");
      return setRecord(scope, key, value);
    });

    await expect(
      sdk.trigger("mem::import", {
        exportData: {
          version: "0.9.27",
          exportedAt: new Date().toISOString(),
          sessions: [],
          observations: {},
          memories: [importedMemory],
          summaries: [],
        } satisfies ExportData,
        strategy: "replace",
      }),
    ).rejects.toThrow("injected audit write failure");

    expect(await kv.get(KV.memories, testMemory.id)).toEqual(testMemory);
    expect(getSearchIndex().has(testMemory.id)).toBe(true);
    expect(getSearchIndex().has(importedMemory.id)).toBe(false);
    expect(persistedStates.at(-1)).toEqual({ original: true, replacement: false });
  });

  it("rolls back replace when vector rebuilding is incomplete", async () => {
    const importedMemories = Array.from({ length: 33 }, (_, index) => ({
      ...testMemory,
      id: `mem_partial_${index}`,
      title: `Partial replacement ${index}`,
      content: `Partial replacement content ${index}`,
      sessionIds: [],
    }));
    getSearchIndex().clear();
    await rebuildIndex(kv as never);
    const vectors = new VectorIndex();
    vectors.add(testMemory.id, "ses_1", new Float32Array([1, 0, 0]));
    setVectorIndex(vectors);
    let embedBatchCalls = 0;
    setEmbeddingProvider({
      name: "partial",
      dimensions: 3,
      embed: async () => new Float32Array([0, 1, 0]),
      embedBatch: async (texts) => {
        embedBatchCalls++;
        if (embedBatchCalls === 2) throw new Error("embedding batch failed");
        return texts.map(() => new Float32Array([0, 1, 0]));
      },
    });
    const persistedVectors: string[] = [];
    setIndexPersistence({
      scheduleSave: vi.fn(),
      save: vi.fn(async () => {
        persistedVectors.push(getVectorIndex()?.serialize() ?? "");
      }),
      saveStrict: vi.fn(async () => {
        persistedVectors.push(getVectorIndex()?.serialize() ?? "");
      }),
    });

    await expect(
      sdk.trigger("mem::import", {
        exportData: {
          version: "0.9.27",
          exportedAt: new Date().toISOString(),
          sessions: [],
          observations: {},
          memories: importedMemories,
          summaries: [],
        } satisfies ExportData,
        strategy: "replace",
      }),
    ).rejects.toThrow("vector index rebuild incomplete");

    expect(embedBatchCalls).toBe(3);
    expect(await kv.get(KV.memories, testMemory.id)).toEqual(testMemory);
    expect(await kv.get(KV.memories, importedMemories[0].id)).toBeNull();
    expect(getSearchIndex().has(testMemory.id)).toBe(true);
    expect(getSearchIndex().has(importedMemories[0].id)).toBe(false);
    expect(getVectorIndex()?.serialize()).toContain(`"${testMemory.id}"`);
    expect(getVectorIndex()?.serialize()).not.toContain(`"${importedMemories[0].id}"`);
    expect(persistedVectors.at(-1)).toContain(`"${testMemory.id}"`);
  });

  it("does not delete replace-orphaned images before audit succeeds", async () => {
    const imageRef = "/managed/pre-import.png";
    await kv.set(KV.memories, testMemory.id, { ...testMemory, imageRef });
    await kv.set(KV.imageRefs, imageRef, 1);
    await kv.set(KV.imageEmbeddings, imageRef, { embedding: [1, 2, 3] });
    vi.mocked(deleteImage).mockClear();
    const setRecord = kv.set;
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (scope === KV.audit) throw new Error("injected audit write failure");
      return setRecord(scope, key, value);
    });

    await expect(
      sdk.trigger("mem::import", {
        exportData: {
          version: "0.9.27",
          exportedAt: new Date().toISOString(),
          sessions: [],
          observations: {},
          memories: [],
          summaries: [],
        } satisfies ExportData,
        strategy: "replace",
      }),
    ).rejects.toThrow("injected audit write failure");

    expect(deleteImage).not.toHaveBeenCalled();
    expect(await kv.get(KV.imageEmbeddings, imageRef)).toEqual({
      embedding: [1, 2, 3],
    });
  });

  it("preserves a concurrent same-key write when replace rolls back", async () => {
    const setRecord = kv.set;
    let releaseImportedWrite = () => {};
    const importedWriteBlocked = new Promise<void>((resolve) => {
      releaseImportedWrite = resolve;
    });
    let markImportedWriteStarted = () => {};
    const importedWriteStarted = new Promise<void>((resolve) => {
      markImportedWriteStarted = resolve;
    });
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (scope === KV.sessions && key === "ses_same_key_rollback") {
        markImportedWriteStarted();
        await importedWriteBlocked;
        throw new Error("injected import write failure");
      }
      return setRecord(scope, key, value);
    });

    const importing = sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [{ ...testSession, id: "ses_same_key_rollback" }],
        observations: {},
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "replace",
    });
    await importedWriteStarted;
    const concurrentMemory = {
      ...testMemory,
      content: "Concurrent writer wins",
    };
    await kv.set(KV.memories, concurrentMemory.id, concurrentMemory);
    releaseImportedWrite();

    await expect(importing).rejects.toThrow("injected import write failure");
    expect(await kv.get(KV.memories, concurrentMemory.id)).toEqual(
      concurrentMemory,
    );
  });

  it("restores a concurrent same-key value overwritten before replace rollback", async () => {
    const deleteRecord = kv.delete;
    let releaseClearedSession = () => {};
    const clearedSessionBlocked = new Promise<void>((resolve) => {
      releaseClearedSession = resolve;
    });
    let markClearedSession = () => {};
    const clearedSession = new Promise<void>((resolve) => {
      markClearedSession = resolve;
    });
    vi.spyOn(kv, "delete").mockImplementation(async (scope, key) => {
      const result = await deleteRecord(scope, key);
      if (scope === KV.sessions && key === testSession.id) {
        markClearedSession();
        await clearedSessionBlocked;
      }
      return result;
    });
    const setRecord = kv.set;
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (scope === KV.sessions && key === "ses_rollback_failure") {
        throw new Error("injected import write failure");
      }
      return setRecord(scope, key, value);
    });
    const concurrentSession = { ...testSession, project: "concurrent project" };

    const importing = sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [
          { ...testSession, project: "imported project" },
          { ...testSession, id: "ses_rollback_failure" },
        ],
        observations: {},
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "replace",
    });
    await clearedSession;
    await kv.set(KV.sessions, concurrentSession.id, concurrentSession);
    releaseClearedSession();

    await expect(importing).rejects.toThrow("injected import write failure");
    expect(await kv.get(KV.sessions, concurrentSession.id)).toEqual(
      concurrentSession,
    );
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

  it("round-trips access logs for every exported owner type", async () => {
    const semantic = { id: "sem_1", fact: "Semantic owner" };
    const procedural = { id: "proc_1", procedure: "Procedural owner" };
    const lesson = { id: "lesson_1", content: "Lesson owner" };
    await kv.set(KV.semantic, semantic.id, semantic);
    await kv.set(KV.procedural, procedural.id, procedural);
    await kv.set(KV.lessons, lesson.id, lesson);
    const ownerIds = [
      testObs.id,
      testMemory.id,
      semantic.id,
      procedural.id,
      lesson.id,
    ];
    for (const memoryId of [...ownerIds, "orphan_1"]) {
      await kv.set(KV.accessLog, memoryId, {
        memoryId,
        count: 2,
        lastAt: "2026-07-16T20:00:00.000Z",
        recent: [1, 2],
      });
    }

    const exported = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(exported.accessLogs?.map((log) => log.memoryId).sort()).toEqual(
      [...ownerIds].sort(),
    );

    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);
    await freshSdk.trigger("mem::import", {
      exportData: exported,
      strategy: "merge",
    });

    for (const memoryId of ownerIds) {
      expect(await freshKv.get(KV.accessLog, memoryId)).toMatchObject({
        memoryId,
        count: 2,
      });
    }
    expect(await freshKv.get(KV.accessLog, "orphan_1")).toBeNull();
  });

  it("rebuilds pending compression entries for incomplete imported raw payloads", async () => {
    const sessionId = "ses_pending_import";
    const raw = {
      ...testRawPayload,
      id: "obs_pending_import",
      sessionId,
    };
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: sessionId }],
      observations: { [sessionId]: [] },
      rawPayloads: [raw],
      memories: [],
      summaries: [],
    };

    const result = await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    });

    expect(result).toMatchObject({ success: true });
    expect(await kv.get(KV.pendingCompression(sessionId), raw.id)).toEqual({
      id: raw.id,
      sessionId,
    });
    expect(await kv.get(KV.rawPayloadsBySession(sessionId), raw.id)).toEqual({
      id: raw.id,
      sessionId,
    });
  });

  it("does not leave pending entries for imported compressed observations", async () => {
    const sessionId = "ses_complete_import";
    const raw = {
      ...testRawPayload,
      id: "obs_complete_import",
      sessionId,
    };
    const observation = {
      ...testObs,
      id: raw.id,
      sessionId,
    };
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: sessionId }],
      observations: { [sessionId]: [observation] },
      rawPayloads: [raw],
      memories: [],
      summaries: [],
    };

    const result = await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    });

    expect(result).toMatchObject({ success: true });
    expect(await kv.list(KV.pendingCompression(sessionId))).toHaveLength(0);
  });

  it("indexes an existing incomplete raw payload under skip strategy", async () => {
    const sessionId = "ses_existing_pending";
    const raw = {
      ...testRawPayload,
      id: "obs_existing_pending",
      sessionId,
    };
    await kv.set(KV.sessions, sessionId, { ...testSession, id: sessionId });
    await kv.set(KV.rawPayloads, raw.id, raw);
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: sessionId }],
      observations: { [sessionId]: [] },
      rawPayloads: [raw],
      memories: [],
      summaries: [],
    };

    const result = await sdk.trigger("mem::import", {
      exportData,
      strategy: "skip",
    });

    expect(result).toMatchObject({ success: true });
    expect(await kv.get(KV.pendingCompression(sessionId), raw.id)).toEqual({
      id: raw.id,
      sessionId,
    });
  });

  it("rejects a raw payload whose session is unavailable", async () => {
    const raw = {
      ...testRawPayload,
      id: "obs_missing_session",
      sessionId: "ses_missing",
    };
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      rawPayloads: [raw],
      memories: [],
      summaries: [],
    };

    const result = await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    });

    expect(result).toMatchObject({
      success: false,
      error: "rawPayloads references unavailable session ses_missing",
    });
    expect(await kv.get(KV.rawPayloads, raw.id)).toBeNull();
    expect(await kv.list(KV.pendingCompression(raw.sessionId))).toHaveLength(0);
  });

  it.each(["merge", "skip"] as const)(
    "%s accepts an observation bucket for an existing session",
    async (strategy) => {
      const observation = {
        ...testObs,
        id: `obs_existing_${strategy}`,
      };
      const exportData: ExportData = {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: { ses_1: [observation] },
        memories: [],
        summaries: [],
      };

      const result = await sdk.trigger("mem::import", {
        exportData,
        strategy,
      });

      expect(result).toMatchObject({ success: true });
      expect(await kv.get(KV.observations("ses_1"), observation.id)).toEqual(
        observation,
      );
    },
  );

  it("revalidates an existing session after a concurrent full-session writer", async () => {
    let releaseWriter = () => {};
    const writerBlocked = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let markWriterStarted = () => {};
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const deletingSession = withObservationSessionOwnerLock(
      testSession.id,
      async () => {
        markWriterStarted();
        await writerBlocked;
        await kv.delete(KV.sessions, testSession.id);
      },
    );
    await writerStarted;
    const importedObservation = { ...testObs, id: "obs_after_delete" };
    const importing = sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: { [testSession.id]: [importedObservation] },
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "merge",
    });

    releaseWriter();
    await deletingSession;
    const result = await importing;

    expect(result).toMatchObject({
      success: false,
      error: `observation bucket references unavailable session ${testSession.id}`,
    });
    expect(
      await kv.get(KV.observations(testSession.id), importedObservation.id),
    ).toBeNull();
  });

  it.each(["merge", "skip"] as const)(
    "%s rejects an observation bucket whose session is unavailable",
    async (strategy) => {
      const sessionId = "ses_missing";
      const exportData: ExportData = {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: {
          [sessionId]: [{ ...testObs, id: "obs_missing", sessionId }],
        },
        memories: [],
        summaries: [],
      };

      const result = await sdk.trigger("mem::import", {
        exportData,
        strategy,
      });

      expect(result).toMatchObject({
        success: false,
        error: `observation bucket references unavailable session ${sessionId}`,
      });
      expect(await kv.list(KV.observations(sessionId))).toHaveLength(0);
    },
  );

  it("replace rejects an observation bucket for a session omitted from the import", async () => {
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: { ses_1: [testObs] },
      memories: [],
      summaries: [],
    };

    const result = await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    });

    expect(result).toMatchObject({
      success: false,
      error: "observation bucket references unavailable session ses_1",
    });
    expect(await kv.get(KV.sessions, "ses_1")).toEqual(testSession);
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

  it("rejects duplicate observation ids across session buckets", async () => {
    const secondSession = { ...testSession, id: "ses_2" };
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [testSession, secondSession],
      observations: {
        ses_1: [testObs],
        ses_2: [{ ...testObs, sessionId: "ses_2" }],
      },
      memories: [],
      summaries: [],
    };

    const result = await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    });

    expect(result).toMatchObject({
      success: false,
      error: `duplicate observation id ${testObs.id}`,
    });
  });

  it("rejects raw and compressed owners with conflicting sessions", async () => {
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [testSession, { ...testSession, id: "ses_2" }],
      observations: { ses_1: [testObs] },
      rawPayloads: [{ ...testRawPayload, sessionId: "ses_2" }],
      memories: [],
      summaries: [],
    };

    const result = await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    });

    expect(result).toMatchObject({
      success: false,
      error: `observation ${testObs.id} has conflicting session ids`,
    });
  });

  it.each(["merge", "skip"] as const)(
    "%s rejects a compressed observation already owned by another session",
    async (strategy) => {
      const secondSession = { ...testSession, id: "ses_2" };
      await kv.delete(KV.rawPayloads, testObs.id);

      const result = await sdk.trigger("mem::import", {
        exportData: {
          version: "0.9.27",
          exportedAt: new Date().toISOString(),
          sessions: [secondSession],
          observations: {
            [secondSession.id]: [{ ...testObs, sessionId: secondSession.id }],
          },
          memories: [],
          summaries: [],
        } satisfies ExportData,
        strategy,
      });

      expect(result).toMatchObject({
        success: false,
        error: `observation ${testObs.id} already belongs to session ${testSession.id}`,
      });
      expect(
        await kv.get(KV.observations(secondSession.id), testObs.id),
      ).toBeNull();
    },
  );

  it.each(["merge", "skip"] as const)(
    "%s rejects a raw observation already owned by another session",
    async (strategy) => {
      const secondSession = { ...testSession, id: "ses_2" };
      await kv.delete(KV.observations(testSession.id), testObs.id);

      const result = await sdk.trigger("mem::import", {
        exportData: {
          version: "0.9.27",
          exportedAt: new Date().toISOString(),
          sessions: [secondSession],
          observations: {},
          rawPayloads: [{ ...testRawPayload, sessionId: secondSession.id }],
          memories: [],
          summaries: [],
        } satisfies ExportData,
        strategy,
      });

      expect(result).toMatchObject({
        success: false,
        error: `observation ${testObs.id} already belongs to session ${testSession.id}`,
      });
      expect(await kv.get(KV.rawPayloads, testObs.id)).toEqual(testRawPayload);
    },
  );

  it("does not let in-flight compression resurrect observations after replace", async () => {
    const { provider, started, release } = blockingCompressionProvider();
    registerCompressFunction(sdk as never, kv as never, provider);
    const compressing = sdk.trigger("mem::compress", {
      observationId: testRawPayload.id,
      sessionId: testRawPayload.sessionId,
      raw: testRawPayload,
      requireStoredRaw: true,
    });
    await started;

    const importing = sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: {},
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "replace",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([compressing, importing]);

    expect(await kv.get(KV.rawPayloads, testRawPayload.id)).toBeNull();
    expect(
      await kv.get(KV.observations(testSession.id), testObs.id),
    ).toBeNull();
  });

  it("does not let in-flight compression overwrite imported observation owners", async () => {
    const { provider, started, release } = blockingCompressionProvider();
    registerCompressFunction(sdk as never, kv as never, provider);
    const importedObservation = {
      ...testObs,
      title: "Imported observation",
      narrative: "Imported observation wins.",
    };
    const importedRaw = {
      ...testRawPayload,
      hookType: "prompt_submit",
    };
    const compressing = sdk.trigger("mem::compress", {
      observationId: testRawPayload.id,
      sessionId: testRawPayload.sessionId,
      raw: testRawPayload,
      requireStoredRaw: true,
    });
    await started;

    const importing = sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [testSession],
        observations: { [testSession.id]: [importedObservation] },
        rawPayloads: [importedRaw],
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "merge",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([compressing, importing]);

    expect(await kv.get(KV.observations(testSession.id), testObs.id)).toEqual(
      importedObservation,
    );
    expect(await kv.get(KV.rawPayloads, testRawPayload.id)).toEqual(
      importedRaw,
    );
  });

  it("does not let an in-flight non-image observation survive replace", async () => {
    await kv.delete(KV.sessions, testSession.id);
    await kv.delete(KV.rawPayloads, testRawPayload.id);
    await kv.delete(KV.observations(testSession.id), testObs.id);
    registerObserveFunction(sdk as never, kv as never);
    const setRecord = kv.set;
    let releaseSyntheticWrite = () => {};
    const syntheticWriteBlocked = new Promise<void>((resolve) => {
      releaseSyntheticWrite = resolve;
    });
    let markSyntheticWriteStarted = () => {};
    const syntheticWriteStarted = new Promise<void>((resolve) => {
      markSyntheticWriteStarted = resolve;
    });
    let blockSyntheticWrite = true;
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (blockSyntheticWrite && scope === KV.observations(testSession.id)) {
        blockSyntheticWrite = false;
        markSyntheticWriteStarted();
        await syntheticWriteBlocked;
      }
      return setRecord(scope, key, value);
    });
    const observing = sdk.trigger("mem::observe", {
      sessionId: testSession.id,
      project: testSession.project,
      cwd: testSession.cwd,
      hookType: "prompt_submit",
      timestamp: "2026-07-16T20:00:00.000Z",
      data: { prompt: "Capture while import replaces state" },
    }) as Promise<{ observationId: string }>;
    await syntheticWriteStarted;

    const importing = sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: {},
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "replace",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseSyntheticWrite();
    const [{ observationId }] = await Promise.all([observing, importing]);

    expect(await kv.get(KV.sessions, testSession.id)).toBeNull();
    expect(await kv.get(KV.rawPayloads, observationId)).toBeNull();
    expect(
      await kv.get(KV.observations(testSession.id), observationId),
    ).toBeNull();
    expect(getSearchIndex().has(observationId)).toBe(false);
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
    await kv.set(KV.imageEmbeddings, "/managed/old.png", {
      embedding: [1, 2, 3],
    });
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
    expect(await kv.get(KV.imageEmbeddings, "/managed/old.png")).toBeNull();
    expect(await kv.get("mem:image-refs", "/managed/new.png")).toBe(1);
  });

  it("commits replace when an orphan cleanup fails and retains retry state", async () => {
    const failedRef = "/managed/retryable.png";
    const releasedRef = "/managed/released.png";
    const failedEmbedding = { embedding: [1, 2, 3] };
    await kv.set(KV.memories, testMemory.id, {
      ...testMemory,
      imageRef: failedRef,
    });
    await kv.set(KV.observations(testSession.id), testObs.id, {
      ...testObs,
      imageRef: releasedRef,
    });
    await kv.set(KV.imageRefs, failedRef, 1);
    await kv.set(KV.imageRefs, releasedRef, 1);
    await kv.set(KV.imageEmbeddings, failedRef, failedEmbedding);
    await kv.set(KV.imageEmbeddings, releasedRef, { embedding: [4, 5, 6] });
    vi.mocked(logger.warn).mockClear();
    const deleteRecord = kv.delete;
    let failCleanup = true;
    vi.spyOn(kv, "delete").mockImplementation(async (scope, key) => {
      if (failCleanup && scope === KV.imageEmbeddings && key === failedRef) {
        failCleanup = false;
        throw new Error("injected orphan cleanup failure");
      }
      return deleteRecord(scope, key);
    });

    const result = (await sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: {},
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "replace",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(await kv.get(KV.imageRefs, failedRef)).toBe(1);
    expect(await kv.get(KV.imageEmbeddings, failedRef)).toEqual(
      failedEmbedding,
    );
    expect(await kv.get(KV.imageRefs, releasedRef)).toBeNull();
    expect(await kv.get(KV.imageEmbeddings, releasedRef)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "Import orphan image cleanup failed",
      {
        imageRef: failedRef,
        error: "injected orphan cleanup failure",
      },
    );
  });

  it("holds image owner deletion until reference rebuild completes", async () => {
    const imageRef = "/managed/import-barrier.png";
    await kv.set(KV.memories, "mem_1", { ...testMemory, imageRef });
    await kv.set(KV.imageRefs, imageRef, 1);
    const setRecord = kv.set;
    let blockRebuild = true;
    let releaseRebuild: () => void = () => {};
    const rebuildBlocked = new Promise<void>((resolve) => {
      releaseRebuild = resolve;
    });
    let markRebuildStarted: () => void = () => {};
    const rebuildStarted = new Promise<void>((resolve) => {
      markRebuildStarted = resolve;
    });
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (blockRebuild && scope === KV.imageRefs && key === imageRef) {
        blockRebuild = false;
        markRebuildStarted();
        await rebuildBlocked;
      }
      return setRecord(scope, key, value);
    });
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    };

    const importing = sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    });
    await rebuildStarted;
    const deleting = deleteImageBackedRecord(
      sdk as never,
      kv as never,
      KV.memories,
      "mem_1",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(await kv.get(KV.memories, "mem_1")).not.toBeNull();

    releaseRebuild();
    await Promise.all([importing, deleting]);
  });

  it("releases the image ownership barrier before search rebuild", async () => {
    const imageRef = "/managed/search-rebuild.png";
    await kv.set(KV.memories, "mem_1", { ...testMemory, imageRef });
    await kv.set(KV.imageRefs, imageRef, 1);
    const setRecord = kv.set;
    const listRecord = kv.list;
    let refsRebuilt = false;
    let blockSearchRebuild = true;
    let releaseSearchRebuild: () => void = () => {};
    const searchRebuildBlocked = new Promise<void>((resolve) => {
      releaseSearchRebuild = resolve;
    });
    let markSearchRebuildStarted: () => void = () => {};
    const searchRebuildStarted = new Promise<void>((resolve) => {
      markSearchRebuildStarted = resolve;
    });
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      const result = await setRecord(scope, key, value);
      if (scope === KV.imageRefs && key === imageRef) refsRebuilt = true;
      return result;
    });
    vi.spyOn(kv, "list").mockImplementation(async (scope) => {
      if (blockSearchRebuild && refsRebuilt && scope === KV.sessions) {
        blockSearchRebuild = false;
        markSearchRebuildStarted();
        await searchRebuildBlocked;
      }
      return listRecord(scope);
    });
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    };

    const importing = sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    });
    await searchRebuildStarted;
    const deleting = deleteImageBackedRecord(
      sdk as never,
      kv as never,
      KV.memories,
      "mem_1",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(await kv.get(KV.memories, "mem_1")).toBeNull();

    releaseSearchRebuild();
    await Promise.all([importing, deleting]);
  });

  it("serializes imports through search rebuild and persistence", async () => {
    const imageRef = "/managed/serialized-import.png";
    const setRecord = kv.set;
    const listRecord = kv.list;
    let refsRebuilt = false;
    let releaseSearchRebuild = () => {};
    const searchRebuildBlocked = new Promise<void>((resolve) => {
      releaseSearchRebuild = resolve;
    });
    let markSearchRebuildStarted = () => {};
    const searchRebuildStarted = new Promise<void>((resolve) => {
      markSearchRebuildStarted = resolve;
    });
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      const result = await setRecord(scope, key, value);
      if (scope === KV.imageRefs && key === imageRef) refsRebuilt = true;
      return result;
    });
    vi.spyOn(kv, "list").mockImplementation(async (scope) => {
      if (refsRebuilt && scope === KV.sessions) {
        refsRebuilt = false;
        markSearchRebuildStarted();
        await searchRebuildBlocked;
      }
      return listRecord(scope);
    });
    const firstSession = { ...testSession, id: "ses_import_first" };
    const secondSession = { ...testSession, id: "ses_import_second" };
    const firstImport = sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [firstSession],
        observations: {},
        memories: [{ ...testMemory, id: "mem_import_first", imageRef }],
        summaries: [],
      } satisfies ExportData,
      strategy: "merge",
    });
    await searchRebuildStarted;

    const secondImport = sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [secondSession],
        observations: {},
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "merge",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const secondSessionBeforeRelease = await kv.get(
      KV.sessions,
      secondSession.id,
    );
    releaseSearchRebuild();
    await Promise.all([firstImport, secondImport]);
    expect(secondSessionBeforeRelease).toBeNull();
    expect(await kv.get(KV.sessions, secondSession.id)).toEqual(secondSession);
  });

  it("waits for active index maintenance before mutating the corpus", async () => {
    const listRecord = kv.list;
    let blockMemoryList = true;
    let releaseMaintenance = () => {};
    const maintenanceBlocked = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });
    let markMaintenanceStarted = () => {};
    const maintenanceStarted = new Promise<void>((resolve) => {
      markMaintenanceStarted = resolve;
    });
    vi.spyOn(kv, "list").mockImplementation(async (scope) => {
      if (blockMemoryList && scope === KV.memories) {
        blockMemoryList = false;
        markMaintenanceStarted();
        await maintenanceBlocked;
      }
      return listRecord(scope);
    });
    const maintenance = rebuildIndex(kv as never);
    await maintenanceStarted;
    const importedSession = { ...testSession, id: "ses_after_maintenance" };
    const importing = sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.27",
        exportedAt: new Date().toISOString(),
        sessions: [importedSession],
        observations: {},
        memories: [],
        summaries: [],
      } satisfies ExportData,
      strategy: "merge",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(await kv.get(KV.sessions, importedSession.id)).toBeNull();

    releaseMaintenance();
    await Promise.all([maintenance, importing]);
    expect(await kv.get(KV.sessions, importedSession.id)).toEqual(
      importedSession,
    );
  });

  it("keeps a failed release journal and aborts import before writes", async () => {
    const imageRef = "/managed/pending-release.png";
    const releaseId = `record:${KV.memories}:mem_deleted`;
    await kv.set(KV.imageReleases, releaseId, {
      id: releaseId,
      refs: [imageRef],
      kind: "record",
      scope: KV.memories,
      recordId: "mem_deleted",
      owner: { ...testMemory, id: "mem_deleted", imageRef },
    });
    const setRecord = kv.set;
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (scope === KV.imageRefs && key === imageRef) {
        throw new Error("ref state unavailable");
      }
      return setRecord(scope, key, value);
    });
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_new" }],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "pending image releases must complete before import",
    );
    expect(await kv.get(KV.imageReleases, releaseId)).not.toBeNull();
    expect(await kv.get(KV.sessions, "ses_new")).toBeNull();
  });

  it("does not roll back a completed pending observation release", async () => {
    const releaseId = `observation:${testSession.id}:${testObs.id}`;
    const session = { ...testSession, observationCount: 2 };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.imageReleases, releaseId, {
      id: releaseId,
      refs: [],
      kind: "observation",
      sessionId: testSession.id,
      observationId: testObs.id,
      observation: testObs,
      raw: testRawPayload,
    });
    const update = vi.spyOn(kv, "update");
    const setRecord = kv.set;
    const failingSessions = new Set([
      "ses_pending_release_failure",
      "ses_pending_release_retry_failure",
    ]);
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (scope === KV.sessions && failingSessions.has(key)) {
        throw new Error("injected import write failure");
      }
      return setRecord(scope, key, value);
    });
    const failedReplace = (id: string) =>
      sdk.trigger("mem::import", {
        exportData: {
          version: "0.9.27",
          exportedAt: new Date().toISOString(),
          sessions: [{ ...testSession, id }],
          observations: {},
          memories: [],
          summaries: [],
        } satisfies ExportData,
        strategy: "replace",
      });

    await expect(failedReplace("ses_pending_release_failure")).rejects.toThrow(
      "injected import write failure",
    );
    await expect(
      failedReplace("ses_pending_release_retry_failure"),
    ).rejects.toThrow("injected import write failure");

    expect({
      release: await kv.get(KV.imageReleases, releaseId),
      session: await kv.get(KV.sessions, session.id),
      observation: await kv.get(KV.observations(testSession.id), testObs.id),
      raw: await kv.get(KV.rawPayloads, testRawPayload.id),
      updateCount: update.mock.calls.length,
    }).toEqual({
      release: null,
      session: {
        ...session,
        observationCount: 1,
        appliedObservationDeletionIds: [],
      },
      observation: null,
      raw: null,
      updateCount: 2,
    });
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
