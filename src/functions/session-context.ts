import type {
  CompressedObservation,
  ContextBlock,
  Session,
  SessionSummary,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface SessionContextInput {
  readonly sessionId: string;
  readonly project: string;
}

async function buildSubagentRollup(
  kv: StateKV,
  sessions: readonly Session[],
  parentSessionId: string,
): Promise<ContextBlock | null> {
  const parent = sessions.find(
    (session) => session.id === parentSessionId && !session.parentSessionId,
  );
  if (!parent) return null;

  const children = sessions.filter(
    (session) =>
      session.parentSessionId === parentSessionId &&
      session.project === parent.project &&
      session.agentId === parent.agentId,
  );
  if (children.length === 0) return null;

  const visibleChildren = children
    .slice()
    .sort((left, right) =>
      (right.updatedAt ?? right.startedAt).localeCompare(
        left.updatedAt ?? left.startedAt,
      ),
    )
    .slice(0, 20);

  const summaries = await Promise.all(
    visibleChildren.map((child) =>
      kv.get<SessionSummary>(KV.summaries, child.id).catch(() => null),
    ),
  );
  const labels = visibleChildren.map((child, index) => {
    const summary = summaries[index];
    return (
      summary?.title ??
      child.summary ??
      child.firstPrompt ??
      child.id.slice(0, 8)
    );
  });
  const files = Array.from(
    new Set(summaries.flatMap((summary) => summary?.filesModified ?? [])),
  ).slice(0, 10);
  const observationCount = children.reduce(
    (total, child) => total + child.observationCount,
    0,
  );
  const taskLines = labels
    .map((label) => `- ${escapeXmlText(label)}`)
    .join("\n");
  const omitted = children.length - visibleChildren.length;
  const omittedLine = omitted > 0 ? `\n- ${omitted} more tasks` : "";
  const filesLine =
    files.length > 0
      ? `\nKey files touched: ${files.map(escapeXmlText).join(", ")}`
      : "";
  const content = `<subagent-activity-summary task-count="${children.length}" observation-count="${observationCount}">\n## Subagent activity summary\nTasks:\n${taskLines}${omittedLine}${filesLine}\n</subagent-activity-summary>`;
  const recency = children.reduce((latest, child) => {
    const timestamp = new Date(
      child.updatedAt ?? child.endedAt ?? child.startedAt,
    ).getTime();
    return Number.isFinite(timestamp) && timestamp > latest
      ? timestamp
      : latest;
  }, 0);

  return {
    type: "summary",
    content,
    tokens: estimateTokens(content),
    recency,
    priority: 2,
  };
}

export async function buildSessionContextBlocks(
  kv: StateKV,
  input: SessionContextInput,
): Promise<ContextBlock[]> {
  const allSessions = await kv.list<Session>(KV.sessions);
  const currentSession = allSessions.find(
    (session) => session.id === input.sessionId,
  );
  if (!currentSession) return [];
  const blocks: ContextBlock[] = [];
  const subagentRollup = await buildSubagentRollup(
    kv,
    allSessions,
    input.sessionId,
  );
  if (subagentRollup) blocks.push(subagentRollup);

  const sessions = allSessions
    .filter(
      (session) =>
        session.project === currentSession.project &&
        session.agentId === currentSession.agentId &&
        session.id !== input.sessionId &&
        !session.parentSessionId,
    )
    .sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )
    .slice(0, 10);
  const summaries = await Promise.all(
    sessions.map((session) =>
      kv.get<SessionSummary>(KV.summaries, session.id).catch(() => null),
    ),
  );
  const sessionsNeedingObservations: number[] = [];

  for (let index = 0; index < sessions.length; index++) {
    const summary = summaries[index];
    if (!summary) {
      sessionsNeedingObservations.push(index);
      continue;
    }
    const content = `## ${summary.title}\n${summary.narrative}\nDecisions: ${summary.keyDecisions.join("; ")}\nFiles: ${summary.filesModified.join(", ")}`;
    blocks.push({
      type: "summary",
      content,
      tokens: estimateTokens(content),
      recency: new Date(summary.createdAt).getTime(),
    });
  }

  const observationResults = await Promise.all(
    sessionsNeedingObservations.map((index) =>
      kv
        .list<CompressedObservation>(KV.observations(sessions[index].id))
        .catch(() => []),
    ),
  );

  for (
    let resultIndex = 0;
    resultIndex < sessionsNeedingObservations.length;
    resultIndex++
  ) {
    const sessionIndex = sessionsNeedingObservations[resultIndex];
    const important = observationResults[resultIndex].filter(
      (observation) => observation.title && observation.importance >= 5,
    );
    if (important.length === 0) continue;

    const top = important
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5);
    const items = top
      .map(
        (observation) =>
          `- [${observation.type}] ${observation.title}: ${observation.narrative}`,
      )
      .join("\n");
    const session = sessions[sessionIndex];
    const content = `## Session ${session.id.slice(0, 8)} (${session.startedAt})\n${items}`;
    blocks.push({
      type: "observation",
      content,
      tokens: estimateTokens(content),
      recency: new Date(session.startedAt).getTime(),
      sourceIds: top.map((observation) => observation.id),
      sourceScope: "observation",
      sourceSessionId: session.id,
    });
  }

  return blocks;
}
