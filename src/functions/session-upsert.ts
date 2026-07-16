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
  readonly created: boolean;
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
      return { session, created: true, projectConflict: false };
    }

    const observations = await kv.list(KV.observations(input.sessionId));
    const ops: UpdateOp[] = [];
    if (existing.observationCount < observations.length) {
      ops.push({
        type: "set",
        path: "observationCount",
        value: observations.length,
      });
    }
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

    const session =
      ops.length > 0
        ? await kv.update<Session>(KV.sessions, input.sessionId, ops)
        : existing;
    return {
      session,
      created: false,
      projectConflict: existing.project !== input.project,
    };
  });
}
