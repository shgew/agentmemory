import { beforeEach, describe, expect, it } from "vitest";

import { withKeyedLock } from "../src/state/keyed-mutex.js";
import { KV } from "../src/state/schema.js";
import { upsertSession } from "../src/functions/session-upsert.js";
import type { Session } from "../src/types.js";

type UpdateOp = { type: string; path: string; value?: unknown };
type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const setCalls: Array<{ scope: string; key: string }> = [];
  const updateCalls: Array<{ scope: string; key: string; ops: UpdateOp[] }> = [];

  const seed = (scope: string, key: string, value: unknown): void => {
    if (!store.has(scope)) store.set(scope, new Map());
    store.get(scope)?.set(key, value);
  };

  return {
    setCalls,
    updateCalls,
    seed,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      setCalls.push({ scope, key });
      seed(scope, key, value);
      return value;
    },
    update: async <T>(scope: string, key: string, ops: UpdateOp[]): Promise<T> => {
      updateCalls.push({ scope, key, ops });
      const current = (store.get(scope)?.get(key) as Record<string, unknown>) ?? {};
      const next = { ...current };
      for (const op of ops) {
        if (op.type === "set") next[op.path] = op.value;
      }
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

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "race-session",
    project: "project",
    cwd: "/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    observationCount: 0,
    ...overrides,
  };
}

describe("upsertSession observation-count race", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("never regresses observationCount when a concurrent observe holds the obs: lock", async () => {
    const id = "race-session";
    // Count has drifted below the stored observations (one already on disk).
    kv.seed(KV.sessions, id, session({ id, observationCount: 0 }));
    kv.seed(KV.observations(id), "obs-1", { id: "obs-1" });

    const observeEntered = deferred();
    const release = deferred();

    // Simulated concurrent observe: takes the SAME obs: lock upsertSession uses
    // for the count repair, performs a read-modify-write increment, appends a
    // new observation, and holds the lock until released. This is exactly
    // observe.ts's critical section (obs: lock, no session: lock).
    const concurrentObserve = withKeyedLock(`obs:${id}`, async () => {
      observeEntered.resolve();
      await release.promise;
      const current = await kv.get<Session>(KV.sessions, id);
      kv.seed(KV.observations(id), "obs-2", { id: "obs-2" });
      await kv.update<Session>(KV.sessions, id, [
        {
          type: "set",
          path: "observationCount",
          value: (current?.observationCount ?? 0) + 1,
        },
      ]);
    });

    // observe now holds obs:. upsertSession will pass its session: phase and
    // then block acquiring obs: until observe releases.
    await observeEntered.promise;
    const resume = upsertSession(kv, { sessionId: id, project: "project", cwd: "/repo" });
    // Give upsert a chance to reach (and queue behind) the obs: lock.
    await Promise.resolve();
    await Promise.resolve();

    release.resolve();
    await concurrentObserve;
    const result = await resume;

    // observe committed count=1 and there are now 2 observations on disk. The
    // repair runs strictly AFTER observe (serialized by obs:), re-reads count=1,
    // sees 2 observations, and grows to 2. It must never clobber observe's write
    // back down to a stale value.
    const stored = await kv.get<Session>(KV.sessions, id);
    expect(stored?.observationCount).toBe(2);
    expect(result.session.observationCount).toBe(2);
  });

  it("leaves an accurate count untouched (no redundant write, no shrink)", async () => {
    const id = "accurate-session";
    kv.seed(KV.sessions, id, session({ id, observationCount: 2 }));
    kv.seed(KV.observations(id), "obs-1", { id: "obs-1" });
    kv.seed(KV.observations(id), "obs-2", { id: "obs-2" });

    const result = await upsertSession(kv, {
      sessionId: id,
      project: "project",
      cwd: "/repo",
    });

    expect(result.session.observationCount).toBe(2);
    expect((await kv.get<Session>(KV.sessions, id))?.observationCount).toBe(2);
    // No count op should have been written: stored (2) is not < actual (2).
    const countWrites = kv.updateCalls.filter((c) =>
      c.ops.some((op) => op.path === "observationCount"),
    );
    expect(countWrites).toHaveLength(0);
  });
});
