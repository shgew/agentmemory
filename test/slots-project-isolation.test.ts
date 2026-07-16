import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlotsFunctions } from "../src/functions/slots.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  MemorySlot,
  Session,
} from "../src/types.js";

type Handler = (
  data: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      const entries = store.get(scope) ?? new Map<string, unknown>();
      entries.set(key, data);
      store.set(scope, entries);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function wire() {
  const kv = mockKV();
  const handlers = new Map<string, Handler>();
  const sdk = {
    registerFunction: vi.fn((id: string, handler: Handler) => {
      handlers.set(id, handler);
    }),
  } as unknown as import("iii-sdk").ISdk;
  registerSlotsFunctions(sdk, kv as never);
  return { kv, handlers };
}

async function call(
  handlers: Map<string, Handler>,
  functionId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = handlers.get(functionId);
  if (!handler) throw new Error(`missing handler: ${functionId}`);
  return handler(data);
}

async function waitForStartupSeeds(
  kv: ReturnType<typeof mockKV>,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await kv.get(KV.globalSlots, "persona")) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function legacyProjectSlot(
  label: string,
  content: string,
): MemorySlot {
  return {
    label,
    content,
    sizeLimit: 3000,
    description: "legacy project slot",
    pinned: true,
    readOnly: false,
    scope: "project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("project slot isolation", () => {
  let kv: ReturnType<typeof mockKV>;
  let handlers: Map<string, Handler>;

  beforeEach(async () => {
    ({ kv, handlers } = wire());
    await waitForStartupSeeds(kv);
  });

  it("does not expose project A content when project B reads the same label", async () => {
    await call(handlers, "mem::slot-replace", {
      label: "project_context",
      content: "project-a-only",
      project: "project-a",
    });

    const result = await call(handlers, "mem::slot-get", {
      label: "project_context",
      project: "project-b",
    });
    const slot = result["slot"] as { content: string; project: string };

    expect(slot.content).toBe("");
    expect(slot.project).toBe("project-b");
    expect(
      await kv.get<{ content: string }>(
        KV.slots,
        "project-a:project_context",
      ),
    ).toMatchObject({ content: "project-a-only" });
    expect(
      await kv.get<{ content: string }>(
        KV.slots,
        "project-b:project_context",
      ),
    ).toMatchObject({ content: "" });
  });

  it("rejects a project slot write when project is omitted", async () => {
    const result = await call(handlers, "mem::slot-replace", {
      label: "pending_items",
      content: "must stay scoped",
    });

    expect(result["success"]).toBe(false);
    expect(result["error"]).toMatch(/project required/);
  });

  it("rejects an empty project as an omitted project", async () => {
    const result = await call(handlers, "mem::slot-replace", {
      label: "pending_items",
      content: "must stay scoped",
      project: "   ",
    });

    expect(result["success"]).toBe(false);
    expect(result["error"]).toMatch(/project required/);
  });

  it("lazy-seeds sane project defaults on first access", async () => {
    const result = await call(handlers, "mem::slot-get", {
      label: "pending_items",
      project: "never-seeded",
    });
    const slot = result["slot"] as MemorySlot;

    expect(result["success"]).toBe(true);
    expect(slot.content).toBe("");
    expect(slot.project).toBe("never-seeded");
    expect(
      await kv.get(KV.slots, "never-seeded:pending_items"),
    ).toMatchObject({ project: "never-seeded", content: "" });
  });

  it("never returns a legacy unscoped slot during a normal project read", async () => {
    await kv.set(
      KV.slots,
      "project_context",
      legacyProjectSlot("project_context", "legacy-shared-content"),
    );

    const result = await call(handlers, "mem::slot-get", {
      label: "project_context",
      project: "project-a",
    });
    const slot = result["slot"] as MemorySlot;

    expect(slot.content).toBe("");
    expect(slot.project).toBe("project-a");
  });

  it("marks explicit legacy compatibility reads as read-only migration data", async () => {
    await kv.set(
      KV.slots,
      "project_context",
      legacyProjectSlot("project_context", "legacy-shared-content"),
    );

    const result = await call(handlers, "mem::slot-get", {
      label: "project_context",
      legacyUnscoped: true,
    });
    const slot = result["slot"] as MemorySlot;

    expect(result["success"]).toBe(true);
    expect(result["legacyUnscoped"]).toBe(true);
    expect(result["readOnly"]).toBe(true);
    expect(result["warning"]).toMatch(/migrat/i);
    expect(slot.content).toBe("legacy-shared-content");
    expect(slot.readOnly).toBe(true);
  });

  it("keeps global slots project-free", async () => {
    const replaced = await call(handlers, "mem::slot-replace", {
      label: "persona",
      content: "global-persona",
    });
    const fetched = await call(handlers, "mem::slot-get", {
      label: "persona",
    });

    expect(replaced["success"]).toBe(true);
    expect(fetched["success"]).toBe(true);
    expect(fetched["slot"]).toMatchObject({
      content: "global-persona",
      scope: "global",
    });
  });

  it("does not mutate a global slot when a project override is missing", async () => {
    await call(handlers, "mem::slot-replace", {
      label: "persona",
      content: "global-persona",
    });

    const replace = await call(handlers, "mem::slot-replace", {
      label: "persona",
      content: "project-persona",
      project: "project-a",
    });
    const append = await call(handlers, "mem::slot-append", {
      label: "persona",
      text: "project suffix",
      project: "project-a",
    });
    const remove = await call(handlers, "mem::slot-delete", {
      label: "persona",
      project: "project-a",
    });
    const global = await call(handlers, "mem::slot-get", {
      label: "persona",
    });

    expect(replace["success"]).toBe(false);
    expect(append["success"]).toBe(false);
    expect(remove["success"]).toBe(false);
    expect(global["slot"]).toMatchObject({ content: "global-persona" });
  });

  it("fills missing defaults after a partial project seed", async () => {
    await kv.set(KV.slots, "project-a:pending_items", {
      ...legacyProjectSlot("pending_items", "keep me"),
      project: "project-a",
    });

    await call(handlers, "mem::slot-list", { project: "project-a" });

    expect(await kv.get(KV.slots, "project-a:pending_items")).toMatchObject({
      content: "keep me",
    });
    expect(await kv.get(KV.slots, "project-a:project_context")).toMatchObject({
      project: "project-a",
      content: "",
    });
    expect(await kv.get(KV.slots, "project-a:guidance")).toMatchObject({
      project: "project-a",
      content: "",
    });
  });

  it("writes slot reflection only to the acting session project", async () => {
    const sessionId = "session-reflect-project";
    const timestamp = new Date().toISOString();
    await kv.set(
      KV.slots,
      "session_patterns",
      legacyProjectSlot("session_patterns", "legacy-content"),
    );
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "project-a",
      cwd: "/tmp/project-a",
      startedAt: timestamp,
      status: "active",
      observationCount: 1,
    } satisfies Session);
    await kv.set(KV.observations(sessionId), "obs-1", {
      id: "obs-1",
      sessionId,
      timestamp,
      sourceType: "test",
      type: "error",
      title: "compile failure",
      facts: [],
      narrative: "typecheck failed",
      concepts: [],
      files: ["src/a.ts"],
      importance: 5,
    } satisfies CompressedObservation);

    await call(handlers, "mem::slot-reflect", { sessionId });

    const keyed = await kv.get<{ content: string; project: string }>(
      KV.slots,
      "project-a:session_patterns",
    );
    const legacy = await kv.get<{ content: string }>(KV.slots, "session_patterns");
    expect(keyed).toMatchObject({ project: "project-a" });
    expect(keyed?.content).toContain("errors: 1");
    expect(legacy?.content).toBe("legacy-content");
  });

  it("skips reflection when the session project cannot be resolved", async () => {
    const sessionId = "missing-session";
    const timestamp = new Date().toISOString();
    await kv.set(
      KV.slots,
      "session_patterns",
      legacyProjectSlot("session_patterns", "legacy-content"),
    );
    await kv.set(KV.observations(sessionId), "obs-1", {
      id: "obs-1",
      sessionId,
      timestamp,
      sourceType: "test",
      type: "error",
      title: "compile failure",
      facts: [],
      narrative: "typecheck failed",
      concepts: [],
      files: ["src/a.ts"],
      importance: 5,
    } satisfies CompressedObservation);

    const result = await call(handlers, "mem::slot-reflect", { sessionId });

    expect(result).toMatchObject({ success: true, applied: 0 });
    expect(
      await kv.get<{ content: string }>(KV.slots, "session_patterns"),
    ).toMatchObject({ content: "legacy-content" });
  });
});
