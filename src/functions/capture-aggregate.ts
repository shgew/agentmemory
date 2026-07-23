import type { HookPayload, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { getAgentId } from "../config.js";
import { stripPrivateData } from "./privacy.js";

const MAX_DIFF_FILES = 200;
const MAX_FILE_LENGTH = 1024;
const MAX_TOTAL = Number.MAX_SAFE_INTEGER;

type AggregateResult =
  | {
      readonly success: true;
      readonly aggregated: true;
      readonly sessionId: string;
    }
  | { readonly success: false; readonly error: string };

function field(data: unknown, key: string): unknown {
  if (typeof data !== "object" || data === null) return undefined;
  return Reflect.get(data, key);
}

function numberField(data: unknown, key: string): number {
  const value = field(data, key);
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_TOTAL)
    : 0;
}

function sumTotal(current: number | undefined, next: number): number {
  return Math.min((current ?? 0) + next, MAX_TOTAL);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function filesField(data: unknown): string[] {
  const value = field(data, "files");
  return Array.isArray(value)
    ? value.flatMap((file) => {
        if (typeof file !== "string") return [];
        const sanitized = stripPrivateData(file).trim().slice(0, MAX_FILE_LENGTH);
        return sanitized ? [sanitized] : [];
      })
    : [];
}

function identityError(session: Session, payload: HookPayload): string | null {
  const project = textValue(payload.project);
  if (project && project !== session.project) {
    return "observation project does not match session";
  }
  const agentId = getAgentId();
  if (session.agentId && agentId && session.agentId !== agentId) {
    return "observation agent does not match session";
  }
  return null;
}

function stepTotals(session: Session, payload: HookPayload) {
  const current = session.stepTotals;
  return {
    count: sumTotal(current?.count, 1),
    cost: sumTotal(current?.cost, numberField(payload.data, "cost")),
    inputTokens: sumTotal(
      current?.inputTokens,
      numberField(payload.data, "input_tokens"),
    ),
    outputTokens: sumTotal(
      current?.outputTokens,
      numberField(payload.data, "output_tokens"),
    ),
    reasoningTokens: sumTotal(
      current?.reasoningTokens,
      numberField(payload.data, "reasoning_tokens"),
    ),
    lastAt: payload.timestamp,
  };
}

function diffTotals(session: Session, payload: HookPayload) {
  const current = session.diffTotals;
  const files = [...new Set(filesField(payload.data))].slice(0, MAX_DIFF_FILES);
  return {
    events: sumTotal(current?.events, 1),
    additions: numberField(payload.data, "additions"),
    deletions: numberField(payload.data, "deletions"),
    files,
    lastAt: payload.timestamp,
  };
}

export async function aggregateCaptureEvent(
  kv: StateKV,
  payload: HookPayload,
): Promise<AggregateResult> {
  const session = await kv.get<Session>(KV.sessions, payload.sessionId);
  if (session) {
    const error = identityError(session, payload);
    if (error) return { success: false, error };
    const value =
      payload.hookType === "step_finish"
        ? stepTotals(session, payload)
        : diffTotals(session, payload);
    await kv.update<Session>(KV.sessions, payload.sessionId, [
      { type: "set", path: "updatedAt", value: new Date().toISOString() },
      {
        type: "set",
        path:
          payload.hookType === "step_finish" ? "stepTotals" : "diffTotals",
        value,
      },
    ]);
    return { success: true, aggregated: true, sessionId: payload.sessionId };
  }

  const project = textValue(payload.project);
  const cwd = textValue(payload.cwd);
  if (!project || !cwd) {
    return { success: false, error: "session_not_found" };
  }
  const agentId = getAgentId();
  const created: Session = {
    id: payload.sessionId,
    project,
    cwd,
    startedAt: payload.timestamp,
    updatedAt: new Date().toISOString(),
    status: "active",
    observationCount: 0,
    ...(agentId ? { agentId } : {}),
    ...(payload.hookType === "step_finish"
      ? {
          stepTotals: stepTotals(
            {
              id: payload.sessionId,
              project,
              cwd,
              startedAt: payload.timestamp,
              status: "active",
              observationCount: 0,
            },
            payload,
          ),
        }
      : {
          diffTotals: diffTotals(
            {
              id: payload.sessionId,
              project,
              cwd,
              startedAt: payload.timestamp,
              status: "active",
              observationCount: 0,
            },
            payload,
          ),
        }),
  };
  await kv.set(KV.sessions, payload.sessionId, created);
  return { success: true, aggregated: true, sessionId: payload.sessionId };
}
