import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
} from "../types.js";

// Zero-LLM compression path. Converts a RawObservation into a
// CompressedObservation using only heuristics — no Claude call, no token
// spend. This is the default as of 0.8.8 (#138); users who want richer
// LLM-generated summaries set AGENTMEMORY_AUTO_COMPRESS=true.

const EVENT_TYPES: Readonly<Record<string, ObservationType>> = {
  post_tool_failure: "error",
  prompt_submit: "conversation",
  assistant_message: "conversation",
  user_message: "conversation",
  message_removed: "conversation",
  message_part_removed: "conversation",
  reasoning: "conversation",
  question_asked: "conversation",
  question_replied: "conversation",
  question_rejected: "conversation",
  question_v2_asked: "conversation",
  question_v2_replied: "conversation",
  question_v2_rejected: "conversation",
  subagent_start: "subagent",
  subagent_stop: "subagent",
  task_completed: "task",
  step_finish: "task",
  session_diff: "file_edit",
  patch_applied: "file_edit",
  file_watcher: "file_edit",
  command_before: "command_run",
  command_executed: "command_run",
  pty_created: "command_run",
  pty_exited: "command_run",
  permission_asked: "decision",
  permission_replied: "decision",
  permission_v2_asked: "decision",
  permission_v2_replied: "decision",
  agent_selected: "decision",
  vcs_branch_updated: "discovery",
  lsp_diagnostics: "discovery",
  mcp_tools_changed: "discovery",
  retry_attempt: "error",
  mcp_browser_open_failed: "error",
  notification: "notification",
  installation_update_available: "notification",
  session_start: "notification",
  session_end: "notification",
  session_status: "notification",
  session_updated: "notification",
  session_compacted: "notification",
  config_loaded: "notification",
  llm_params: "notification",
  messages_transform: "notification",
  compaction_event: "notification",
  compaction_autocontinue: "notification",
};

const COMPLETION_EVENTS = new Set([
  "task_completed",
  "subagent_stop",
  "step_finish",
  "stop",
  "session_end",
]);

const LOW_VALUE_EVENTS = new Set([
  "session_start",
  "session_status",
  "session_updated",
  "session_compacted",
  "config_loaded",
  "llm_params",
  "messages_transform",
  "compaction_event",
  "compaction_autocontinue",
]);

function inferToolType(toolName: string | undefined): ObservationType {
  if (!toolName) return "other";
  const normalized = toolName
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  const hasWord = (word: string) =>
    new RegExp(`(^|_)${word}(_|$)`).test(normalized) ||
    normalized === word ||
    normalized.endsWith(word) ||
    normalized.startsWith(word);
  if (["fetch", "http", "web"].some(hasWord)) return "web_fetch";
  if (["grep", "search", "glob", "find"].some(hasWord)) return "search";
  if (["bash", "shell", "exec", "run"].some(hasWord)) return "command_run";
  if (["edit", "update", "patch", "replace"].some(hasWord)) return "file_edit";
  if (["write", "create"].some(hasWord)) return "file_write";
  if (["read", "view"].some(hasWord)) return "file_read";
  if (["task", "agent"].some(hasWord)) return "subagent";
  return "other";
}

export function inferObservationType(
  raw: RawObservation,
  fallback: ObservationType = "other",
): ObservationType {
  if (raw.modality === "image") return "image";
  const eventType = EVENT_TYPES[raw.hookType];
  if (eventType) return eventType;
  const toolType = inferToolType(raw.toolName);
  return toolType === "other" ? fallback : toolType;
}

export function observationImportance(
  raw: RawObservation,
  type: ObservationType,
): number {
  if (LOW_VALUE_EVENTS.has(raw.hookType)) return 2;
  if (raw.hookType === "prompt_submit" || COMPLETION_EVENTS.has(raw.hookType)) {
    return 6;
  }
  if (type === "file_edit" || type === "file_write" || type === "command_run") {
    return 7;
  }
  if (type === "decision" || type === "error") return 6;
  // File reads and searches remain searchable through recall at importance 4,
  // but intentionally stay below the >=5 context and consolidation gates.
  if (type === "file_read" || type === "search" || type === "web_fetch") {
    return 4;
  }
  return 5;
}

const MAX_FILE_DEPTH = 4;

function looksLikeFilePath(value: string, key: string): boolean {
  if (value.length === 0 || value.length >= 512 || value.includes("\n")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("data:")) {
    return false;
  }
  const normalizedKey = key.toLowerCase();
  const pathKey = /(^|_)(file|files|filename|filepath|path|paths|cwd|directory|root)($|_)/.test(
    normalizedKey,
  );
  return (
    pathKey ||
    value.includes("/") ||
    value.includes("\\") ||
    /(^|[\\/])\.?[\w@+-]+\.[a-z0-9]{1,12}$/i.test(value)
  );
}

export function extractObservationFiles(raw: RawObservation): string[] {
  const out = new Set<string>();
  const visited = new WeakSet<object>();

  const visit = (value: unknown, depth: number, key: string): void => {
    if (depth > MAX_FILE_DEPTH) return;
    if (typeof value === "string") {
      if (looksLikeFilePath(value, key)) out.add(value);
      return;
    }
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, key);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, depth + 1, childKey);
    }
  };

  visit(raw.toolInput, 0, "toolInput");
  visit(raw.raw, 0, "raw");
  return [...out];
}

function stringifyForNarrative(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

export function buildSyntheticCompression(
  raw: RawObservation,
): CompressedObservation {
  const toolName = raw.toolName ?? raw.hookType;
  const inputStr = stringifyForNarrative(raw.toolInput);
  const outputStr = stringifyForNarrative(raw.toolOutput);
  const promptStr = raw.userPrompt ?? "";
  const type = inferObservationType(raw);

  const narrativeParts = [promptStr, inputStr, outputStr].filter(
    (s) => s.length > 0,
  );

  const result: CompressedObservation = {
    id: raw.id,
    sessionId: raw.sessionId,
    timestamp: raw.timestamp,
    sourceType: raw.hookType,
    ...(raw.toolName ? { toolName: raw.toolName } : {}),
    type,
    title: truncate(toolName || "observation", 80),
    subtitle: inputStr ? truncate(inputStr, 120) : undefined,
    facts: [],
    narrative: truncate(narrativeParts.join(" | "), 400),
    concepts: [],
    files: extractObservationFiles(raw),
    importance: observationImportance(raw, type),
    confidence: 0.3,
  };
  if (raw.modality) result.modality = raw.modality;
  if (raw.imageData) result.imageData = raw.imageData;
  if (raw.agentId) result.agentId = raw.agentId;
  return result;
}
