import { withKeyedLock } from "../state/keyed-mutex.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Session } from "../types.js";

export type SessionUpsertInput = {
  readonly sessionId: string;
  readonly project: string;
  readonly cwd: string;
  readonly summary?: string;
  readonly firstPrompt?: string;
  readonly agentId?: string;
  readonly parentSessionId?: string;
};

export type SessionUpsertResult = {
  readonly session: Session;
  readonly projectConflict: boolean;
};

type UpdateOp = { type: "set"; path: string; value: unknown };

function isEmpty(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

export function upsertSession(
  kv: StateKV,
  input: SessionUpsertInput,
): Promise<SessionUpsertResult> {
  return withKeyedLock(`session:${input.sessionId}`, async () => {
    const existing = await kv.get<Session>(KV.sessions, input.sessionId);
    if (!existing) {
      const session: Session = {
        id: input.sessionId,
        project: input.project,
        cwd: input.cwd,
        startedAt: new Date().toISOString(),
        status: "active",
        observationCount: 0,
        ...(input.parentSessionId
          ? { parentSessionId: input.parentSessionId }
          : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.firstPrompt ? { firstPrompt: input.firstPrompt } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
      };
      await kv.set(KV.sessions, input.sessionId, session);
      return { session, projectConflict: false };
    }

    // Metadata enrichment only backfills empty durable fields; keep it under
    // the outer session: lock. The observation-count repair is deliberately
    // NOT done here — see the nested obs: lock below.
    const ops: UpdateOp[] = [];
    if (isEmpty(existing.summary) && input.summary) {
      ops.push({ type: "set", path: "summary", value: input.summary });
    }
    if (isEmpty(existing.firstPrompt) && input.firstPrompt) {
      ops.push({ type: "set", path: "firstPrompt", value: input.firstPrompt });
    }
    if (isEmpty(existing.cwd)) {
      ops.push({ type: "set", path: "cwd", value: input.cwd });
    }
    if (isEmpty(existing.agentId) && input.agentId) {
      ops.push({ type: "set", path: "agentId", value: input.agentId });
    }
    if (isEmpty(existing.parentSessionId) && input.parentSessionId) {
      ops.push({
        type: "set",
        path: "parentSessionId",
        value: input.parentSessionId,
      });
    }

    if (ops.length > 0) {
      await kv.update<Session>(KV.sessions, input.sessionId, ops);
    }

    // observationCount is a read-modify-write counter that mem::observe
    // maintains under withKeyedLock(`obs:${id}`) WITHOUT ever taking the
    // session: lock (observe.ts:196 lists/updates the sessions row under obs:
    // only). So the session: lock alone never protected the count: a
    // concurrent observe could commit N+1 in the window between our list() and
    // our update(), and our stale write would clobber it (or vice versa).
    // Serialize the repair with observe's increment by running it under the
    // SAME obs: lock — re-read the row, list observations, and only grow the
    // count, never shrink it.
    //
    // Lock order: session: -> obs:. NEVER acquire session: while holding obs:.
    // Verified: the only obs: holders (observe.ts:111/196,
    // session-checkpoint.ts:35) touch the sessions row via kv.update WITHOUT
    // taking session:, and the only other session: holder (api.ts commit-link,
    // api.ts:831) never takes obs:. No path acquires obs: then session:, so
    // there is no lock-ordering cycle and this nesting cannot deadlock.
    const session = await withKeyedLock(`obs:${input.sessionId}`, async () => {
      const current =
        (await kv.get<Session>(KV.sessions, input.sessionId)) ?? existing;
      const observations = await kv.list(KV.observations(input.sessionId));
      if (current.observationCount < observations.length) {
        return kv.update<Session>(KV.sessions, input.sessionId, [
          { type: "set", path: "observationCount", value: observations.length },
        ]);
      }
      return current;
    });

    return {
      session,
      projectConflict: existing.project !== input.project,
    };
  });
}
