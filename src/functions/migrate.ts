import type { ISdk } from "iii-sdk";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { KV, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import type {
  Memory,
  MemorySlot,
  ProjectProfile,
  Session,
  CompressedObservation,
  SessionSummary,
} from "../types.js";
import { logger } from "../logger.js";
import { recordAudit } from "./audit.js";
import { canonicalizeFilePath } from "./profile.js";
import { backfillRawPayloadSessionIndex } from "./raw-payload-session-index.js";

export const DEFAULT_CANONICAL_PROJECT_MAP: Readonly<Record<string, string>> = {};

// Canonical slugs are determined by the values of the effective mapping. Callers
// supply that mapping at call time via `payload.mapping`; this module ships no
// site-specific defaults.

type CanonicalizeProjectPayload = {
  step: "canonicalize-projects";
  dryRun?: boolean;
  mapping?: Record<string, string>;
};

type ProjectRow = {
  id?: string;
  sessionId?: string;
  project?: string | null;
  updatedAt?: string;
};

type ScopeReport = {
  wouldUpdate: number;
  alreadyCanonical: number;
  noMatch: number;
  unscoped: number;
  deleted?: number;
  notes?: string;
};

type CanonicalizeProjectSuccess = {
  success: true;
  step: "canonicalize-projects";
  dryRun: boolean;
  perScope: Record<string, ScopeReport>;
  totalUpdated: number;
  totalDeleted: number;
  totalNoMatch: number;
  totalUnscoped: number;
};

type CanonicalizeProjectFailure = {
  success: false;
  step: "canonicalize-projects";
  error: string;
};

type CanonicalizeProjectResult =
  | CanonicalizeProjectSuccess
  | CanonicalizeProjectFailure;

type ProjectScope<Row extends ProjectRow> = {
  scope: string;
  keyOf: (row: Row) => string;
};

const ALLOWED_DIRS = [resolve(homedir(), ".agentmemory")];

function isAllowedPath(dbPath: string): boolean {
  const resolved = resolve(dbPath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + "/"));
}

// Audit functionId stamped on every unscoped-memory backfill so an
// operator can trace which memory was scoped and on what evidence.
const BACKFILL_FUNCTION_ID = "mem::backfill-unscoped-memories";

// Infer memory project from the majority project of its associated sessions.
// Returns { updated, skipped } — safe to run repeatedly (idempotent).
export async function inferMemoryProjects(
  kv: StateKV,
  dryRun = false,
): Promise<{
  updated: number;
  skipped: number;
  ambiguous: number;
  backfilledIds: string[];
  unresolvedIds: string[];
}> {
  const memories = await kv.list<Memory>(KV.memories);
  const sessionCache = new Map<string, Session | null>();

  const loadSession = async (sid: string): Promise<Session | null> => {
    if (sessionCache.has(sid)) return sessionCache.get(sid)!;
    const s = await kv.get<Session>(KV.sessions, sid).catch(() => null);
    sessionCache.set(sid, s);
    return s;
  };

  let updated = 0;
  let skipped = 0;
  let ambiguous = 0;
  const backfilledIds: string[] = [];
  // Memories that could NOT be confidently scoped. Reported back
  // explicitly so they are never silently left unscoped without signal.
  const unresolvedIds: string[] = [];

  for (const memory of memories) {
    if (memory.project) {
      skipped++;
      continue;
    }

    const sessionIds = memory.sessionIds ?? [];
    if (sessionIds.length === 0) {
      ambiguous++;
      unresolvedIds.push(memory.id);
      continue;
    }

    const projects: string[] = [];
    for (const sid of sessionIds) {
      const session = await loadSession(sid);
      if (session?.project) projects.push(session.project);
    }

    if (projects.length === 0) {
      ambiguous++;
      unresolvedIds.push(memory.id);
      continue;
    }

    // Majority-vote: count frequency of each project value.
    const freq = new Map<string, number>();
    for (const p of projects) freq.set(p, (freq.get(p) ?? 0) + 1);
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const [topProject, topCount] = sorted[0];

    // Require a strict majority (> 50%) to avoid misattributing a memory
    // that was genuinely built from sessions across multiple projects.
    if (topCount <= sessionIds.length / 2) {
      ambiguous++;
      unresolvedIds.push(memory.id);
      continue;
    }

    if (!dryRun) {
      memory.project = topProject;
      await kv.set(KV.memories, memory.id, memory);
      // Audit trail: one row per backfill so an operator can trace
      // exactly which unscoped memory was assigned which project and
      // on what evidence (session vote count).
      await recordAudit(
        kv,
        "canonicalize_projects",
        BACKFILL_FUNCTION_ID,
        [memory.id],
        {
          project: topProject,
          votes: topCount,
          sessionIds,
          backfilledFromUnscoped: true,
        },
      );
    }
    backfilledIds.push(memory.id);
    updated++;
  }

  logger.info("inferMemoryProjects complete", {
    updated,
    skipped,
    ambiguous,
    unresolved: unresolvedIds.length,
    dryRun,
  });
  return { updated, skipped, ambiguous, backfilledIds, unresolvedIds };
}

// Operator-facing wrapper around inferMemoryProjects. Finds memories
// with no project scope, assigns one from the majority project of the
// memory's linked sessions, records an audit trail per backfill, and
// reports back the ids it could NOT confidently scope (rather than
// silently leaving them unscoped with no signal). Idempotent.
export async function backfillUnscopedMemories(
  kv: StateKV,
  dryRun = false,
): Promise<{
  success: true;
  dryRun: boolean;
  updated: number;
  skipped: number;
  ambiguous: number;
  backfilledIds: string[];
  unresolvedIds: string[];
  unresolved: number;
}> {
  const result = await inferMemoryProjects(kv, dryRun);
  if (result.unresolvedIds.length > 0) {
    // Explicit MISLEADING-SUCCESS guard: these memories remain unscoped
    // by design because no confident project could be inferred. Surface
    // them loudly instead of reporting a clean success.
    logger.warn("backfillUnscopedMemories: memories left unscoped", {
      count: result.unresolvedIds.length,
      unresolvedIds: result.unresolvedIds,
      dryRun,
    });
  }
  return {
    success: true,
    dryRun,
    updated: result.updated,
    skipped: result.skipped,
    ambiguous: result.ambiguous,
    backfilledIds: result.backfilledIds,
    unresolvedIds: result.unresolvedIds,
    unresolved: result.unresolvedIds.length,
  };
}

export async function canonicalizeProfilePaths(
  kv: StateKV,
  dryRun = false,
): Promise<{
  success: true;
  dryRun: boolean;
  profilesScanned: number;
  profilesUpdated: number;
  pathsNormalized: number;
}> {
  const profiles = await kv.list<ProjectProfile>(KV.profiles);
  let profilesUpdated = 0;
  let pathsNormalized = 0;
  const touchedIds: string[] = [];

  for (const profile of profiles) {
    if (
      !profile ||
      !profile.project ||
      !Array.isArray(profile.topFiles)
    ) {
      continue;
    }
    const merged = new Map<string, number>();
    let changed = false;
    for (const entry of profile.topFiles) {
      const raw = entry?.file;
      const canonical = canonicalizeFilePath(raw, profile.project);
      if (!canonical) {
        // Unrelatable / empty path carried no usable value: drop it.
        changed = true;
        continue;
      }
      if (canonical !== raw) changed = true;
      const freq =
        typeof entry?.frequency === "number" ? entry.frequency : 0;
      merged.set(canonical, (merged.get(canonical) ?? 0) + freq);
    }
    // A merge (two entries collapsed to one) is also a change.
    if (merged.size !== profile.topFiles.length) changed = true;
    if (!changed) continue;

    profilesUpdated++;
    pathsNormalized += profile.topFiles.length;
    if (!dryRun) {
      const topFiles = [...merged.entries()]
        .map(([file, frequency]) => ({ file, frequency }))
        .sort((a, b) => b.frequency - a.frequency);
      await kv.set(KV.profiles, profile.project, { ...profile, topFiles });
      touchedIds.push(profile.project);
    }
  }

  if (!dryRun && touchedIds.length > 0) {
    await recordAudit(
      kv,
      "canonicalize_projects",
      "mem::migrate",
      touchedIds,
      {
        step: "canonicalize-profile-paths",
        profilesUpdated,
        pathsNormalized,
      },
    );
  }

  logger.info("canonicalizeProfilePaths complete", {
    profilesScanned: profiles.length,
    profilesUpdated,
    pathsNormalized,
    dryRun,
  });

  return {
    success: true,
    dryRun,
    profilesScanned: profiles.length,
    profilesUpdated,
    pathsNormalized,
  };
}

function emptyScopeReport(): ScopeReport {
  return { wouldUpdate: 0, alreadyCanonical: 0, noMatch: 0, unscoped: 0 };
}

export type MappingValidation =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

export function validateMapping(mapping: unknown): MappingValidation {
  if (
    mapping === null ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(mapping))
  ) {
    return {
      ok: false,
      error: "mapping must be a plain object of string keys to string values",
    };
  }
  const obj = mapping as Record<string, unknown>;
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.trim();
    if (key.length === 0) {
      return { ok: false, error: "mapping keys must be non-empty strings" };
    }
    if (typeof v !== "string" || v.trim().length === 0) {
      return {
        ok: false,
        error: `mapping value for "${k}" must be a non-empty string`,
      };
    }
    if (Object.hasOwn(normalized, key)) {
      return {
        ok: false,
        error: `mapping keys collide after trimming: "${key}"`,
      };
    }
    normalized[key] = v.trim();
  }

  const resolved: Record<string, string> = {};
  for (const key of Object.keys(normalized)) {
    const seen = new Set<string>();
    let current = key;
    while (Object.hasOwn(normalized, current) && normalized[current] !== current) {
      if (seen.has(current)) {
        return { ok: false, error: `mapping contains a cycle at "${current}"` };
      }
      seen.add(current);
      current = normalized[current];
    }
    resolved[key] = current;
  }

  return { ok: true, value: resolved };
}

function canonicalProjectSet(mapping: Record<string, string>): ReadonlySet<string> {
  return new Set(Object.values(mapping));
}

function updateProject<Row extends ProjectRow>(row: Row, project: string, updatedAt: string): Row {
  if ("updatedAt" in row) {
    return { ...row, project, updatedAt };
  }
  return { ...row, project };
}

const PATH_SHAPED = /^[/\\]|^[A-Za-z]:[/\\]/;

function projectRowKey(row: ProjectRow): string {
  const raw = row.id ?? row.sessionId ?? row.project ?? "";
  return PATH_SHAPED.test(raw) ? redactProfileKey(raw) : raw;
}

function stripWorktreeSegment(project: string): string {
  const idx = project.indexOf("/.worktrees/");
  return idx >= 0 ? project.slice(0, idx) : project;
}

function redactProfileKey(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `profile-key:${hash}`;
}

async function migrateProjectScope<Row extends ProjectRow>(
  kv: StateKV,
  projectScope: ProjectScope<Row>,
  mapping: Record<string, string>,
  canonicalProjects: ReadonlySet<string>,
  dryRun: boolean,
  touchedIds: string[],
): Promise<ScopeReport> {
  const report = emptyScopeReport();
  const rows = await kv.list<Row>(projectScope.scope);

  for (const row of rows) {
    const project = row.project;
    if (!project) {
      report.unscoped++;
      continue;
    }

    const lookupKey = stripWorktreeSegment(project);
    const mapped = mapping[lookupKey] ?? mapping[project];
    if (mapped !== undefined) {
      if (mapped === project) {
        report.alreadyCanonical++;
        continue;
      }

      report.wouldUpdate++;
      if (!dryRun) {
        const key = projectScope.keyOf(row);
        const updatedAt = new Date().toISOString();
        await kv.set(projectScope.scope, key, updateProject(row, mapped, updatedAt));
        touchedIds.push(key);
      }
      continue;
    }

    if (canonicalProjects.has(project)) {
      report.alreadyCanonical++;
      continue;
    }

    report.noMatch++;
  }

  return report;
}

async function migrateProfiles(
  kv: StateKV,
  mapping: Record<string, string>,
  canonicalProjects: ReadonlySet<string>,
  dryRun: boolean,
  touchedIds: string[],
): Promise<ScopeReport> {
  const report: ScopeReport = { ...emptyScopeReport(), deleted: 0 };
  const rows = await kv.list<ProjectProfile>(KV.profiles);

  for (const row of rows) {
    const key = row.project;
    if (!key) {
      report.unscoped++;
      continue;
    }
    if (PATH_SHAPED.test(key)) {
      report.deleted = (report.deleted ?? 0) + 1;
      if (!dryRun) {
        await kv.delete(KV.profiles, key);
        touchedIds.push(redactProfileKey(key));
      }
      continue;
    }
    if (canonicalProjects.has(key)) {
      report.alreadyCanonical++;
      continue;
    }
    const mapped = mapping[key];
    if (mapped !== undefined && mapped !== key) {
      report.deleted = (report.deleted ?? 0) + 1;
      if (!dryRun) {
        await kv.delete(KV.profiles, key);
        touchedIds.push(key);
      }
      continue;
    }
    report.noMatch++;
  }

  return report;
}

function stateKeyAuditId(prefix: string, key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}

async function migrateProjectSlots(
  kv: StateKV,
  mapping: Record<string, string>,
  canonicalProjects: ReadonlySet<string>,
  dryRun: boolean,
  touchedIds: string[],
): Promise<ScopeReport> {
  const report = emptyScopeReport();
  const rows = await kv.list<MemorySlot>(KV.slots);
  let conflicts = 0;

  for (const row of rows) {
    const project = row.project;
    if (!project) {
      report.unscoped++;
      continue;
    }

    const mapped = mapping[stripWorktreeSegment(project)] ?? mapping[project];
    if (mapped === undefined) {
      if (canonicalProjects.has(project)) report.alreadyCanonical++;
      else report.noMatch++;
      continue;
    }
    if (mapped === project) {
      report.alreadyCanonical++;
      continue;
    }

    const sourceKey = `${project}:${row.label}`;
    const destinationKey = `${mapped}:${row.label}`;
    const destination = await kv.get<MemorySlot>(KV.slots, destinationKey);
    if (
      destination &&
      destination.content.length > 0 &&
      row.content.length > 0 &&
      destination.content !== row.content
    ) {
      conflicts++;
      report.noMatch++;
      continue;
    }

    report.wouldUpdate++;
    if (dryRun) continue;

    const selected = destination && (destination.content || !row.content)
      ? destination
      : row;
    await kv.set(KV.slots, destinationKey, {
      ...selected,
      project: mapped,
      scope: "project",
    });
    await kv.delete(KV.slots, sourceKey);
    touchedIds.push(stateKeyAuditId("slot-key", sourceKey));
  }

  if (conflicts > 0) {
    report.notes = `${conflicts} slot conflicts left at their original keys`;
  }
  return report;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeCursorState(current: unknown, incoming: unknown): unknown {
  if (!isRecord(incoming)) return current ?? incoming;
  if (!isRecord(current)) return incoming;
  const processedFps = [
    ...(Array.isArray(current.processedFps) ? current.processedFps : []),
    ...(Array.isArray(incoming.processedFps) ? incoming.processedFps : []),
  ].filter((value): value is string => typeof value === "string");
  return {
    ...incoming,
    ...current,
    processedFps: [...new Set(processedFps)],
  };
}

function mergeReflectWatermark(current: unknown, incoming: unknown): unknown {
  if (!isRecord(incoming)) return current ?? incoming;
  if (!isRecord(current)) return incoming;
  const currentTime =
    typeof current.at === "string" ? Date.parse(current.at) : Number.NaN;
  const incomingTime =
    typeof incoming.at === "string" ? Date.parse(incoming.at) : Number.NaN;
  if (!Number.isFinite(currentTime)) return incoming;
  if (!Number.isFinite(incomingTime)) return current;
  return incomingTime > currentTime ? incoming : current;
}

async function migrateReflectConfig(
  kv: StateKV,
  mapping: Record<string, string>,
  dryRun: boolean,
  touchedIds: string[],
): Promise<ScopeReport> {
  const report = emptyScopeReport();
  const keyTypes = [
    { prefix: "reflect:cursor", merge: mergeCursorState },
    { prefix: "reflect:last-success", merge: mergeReflectWatermark },
  ] as const;

  for (const [sourceProject, destinationProject] of Object.entries(mapping)) {
    if (sourceProject === "global" || sourceProject === destinationProject) {
      continue;
    }
    for (const { prefix, merge } of keyTypes) {
      const sourceKey = `${prefix}:${sourceProject}`;
      const source = await kv.get<unknown>(KV.config, sourceKey);
      if (source === null) continue;

      report.wouldUpdate++;
      if (dryRun) continue;

      const destinationKey = `${prefix}:${destinationProject}`;
      const destination = await kv.get<unknown>(KV.config, destinationKey);
      await kv.set(KV.config, destinationKey, merge(destination, source));
      await kv.delete(KV.config, sourceKey);
      touchedIds.push(stateKeyAuditId("config-key", sourceKey));
    }
  }

  return report;
}

export async function canonicalizeProjects(
  kv: StateKV,
  payload: CanonicalizeProjectPayload,
): Promise<CanonicalizeProjectResult> {
  const dryRun = payload.dryRun ?? false;
  let effectiveMap: Record<string, string>;
  if (payload.mapping !== undefined) {
    const validation = validateMapping(payload.mapping);
    if (!validation.ok) {
      return {
        success: false,
        step: "canonicalize-projects",
        error: validation.error,
      };
    }
    effectiveMap = validation.value;
  } else {
    effectiveMap = DEFAULT_CANONICAL_PROJECT_MAP;
  }
  const canonicalProjects = canonicalProjectSet(effectiveMap);
  const touchedIds: string[] = [];
  const perScope: Record<string, ScopeReport> = {};

  const projectScopes: Array<ProjectScope<ProjectRow>> = [
    { scope: KV.sessions, keyOf: projectRowKey },
    { scope: KV.memories, keyOf: projectRowKey },
    { scope: KV.summaries, keyOf: projectRowKey },
    { scope: KV.actions, keyOf: projectRowKey },
    { scope: KV.sketches, keyOf: projectRowKey },
    { scope: KV.crystals, keyOf: projectRowKey },
    { scope: KV.lessons, keyOf: projectRowKey },
    { scope: KV.insights, keyOf: projectRowKey },
  ];

  for (const projectScope of projectScopes) {
    perScope[projectScope.scope] = await migrateProjectScope(
      kv,
      projectScope,
      effectiveMap,
      canonicalProjects,
      dryRun,
      touchedIds,
    );
  }

  perScope["mem:team:*:shared"] = {
    ...emptyScopeReport(),
    notes: "team scopes skipped: no enumerator",
  };
  perScope[KV.profiles] = await migrateProfiles(kv, effectiveMap, canonicalProjects, dryRun, touchedIds);
  perScope[KV.slots] = await migrateProjectSlots(
    kv,
    effectiveMap,
    canonicalProjects,
    dryRun,
    touchedIds,
  );
  perScope[KV.config] = await migrateReflectConfig(
    kv,
    effectiveMap,
    dryRun,
    touchedIds,
  );

  let totalUpdated = 0;
  let totalDeleted = 0;
  let totalNoMatch = 0;
  let totalUnscoped = 0;
  for (const report of Object.values(perScope)) {
    totalUpdated += dryRun ? 0 : report.wouldUpdate;
    totalDeleted += dryRun ? 0 : report.deleted ?? 0;
    totalNoMatch += report.noMatch;
    totalUnscoped += report.unscoped;
  }

  if (!dryRun) {
    await recordAudit(kv, "canonicalize_projects", "mem::migrate", touchedIds, {
      perScope,
      totalUpdated,
      totalDeleted,
      totalNoMatch,
      totalUnscoped,
      dryRun: false,
      mappingEntryCount: Object.keys(effectiveMap).length,
      canonicalProjectCount: canonicalProjects.size,
    });
  }

  return {
    success: true,
    step: "canonicalize-projects",
    dryRun,
    perScope,
    totalUpdated,
    totalDeleted,
    totalNoMatch,
    totalUnscoped,
  };
}

export function registerMigrateFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::backfill-unscoped-memories",
    async (data?: { dryRun?: boolean }) => {
      const dryRun = data?.dryRun ?? false;
      logger.info("Backfill unscoped memories", { dryRun });
      return backfillUnscopedMemories(kv, dryRun);
    },
  );

  sdk.registerFunction("mem::migrate",
    async (data: { dbPath?: string; step?: string; dryRun?: boolean; mapping?: Record<string, string> }) => {
      // In-place KV migration steps (no SQLite dependency).
      if (data.step === "infer-memory-projects") {
        const dryRun = data.dryRun ?? false;
        logger.info("Migration step: infer-memory-projects", { dryRun });
        const result = await inferMemoryProjects(kv, dryRun);
        return { success: true, step: "infer-memory-projects", ...result };
      }

      if (data.step === "canonicalize-projects") {
        const dryRun = data.dryRun ?? false;
        logger.info("Migration step: canonicalize-projects", { dryRun });
        return canonicalizeProjects(kv, {
          step: "canonicalize-projects",
          dryRun,
          mapping: data.mapping,
        });
      }

      if (data.step === "raw-payloads-by-session") {
        return backfillRawPayloadSessionIndex(kv, data.dryRun ?? false);
      }

      if (data.step === "canonicalize-profile-paths") {
        const dryRun = data.dryRun ?? false;
        logger.info("Migration step: canonicalize-profile-paths", { dryRun });
        return canonicalizeProfilePaths(kv, dryRun);
      }

      if (!data.dbPath) {
        return {
          success: false,
          error: "Either step or dbPath is required",
        };
      }

      logger.info("Migration started", { dbPath: data.dbPath });

      if (!isAllowedPath(data.dbPath)) {
        return {
          success: false,
          error: `Path not allowed. Must be under: ${ALLOWED_DIRS.join(", ")}`,
        };
      }

      let Database: any;
      try {
        // @ts-expect-error optional dependency
        Database = (await import("better-sqlite3")).default;
      } catch {
        return {
          success: false,
          error:
            "better-sqlite3 not installed. Run: npm install better-sqlite3",
        };
      }

      const fs = await import("node:fs");
      if (!fs.existsSync(data.dbPath)) {
        return { success: false, error: `Database not found: ${data.dbPath}` };
      }

      let db: any;
      try {
        db = Database(data.dbPath, { readonly: true });
        let sessionCount = 0;
        let obsCount = 0;
        let summaryCount = 0;

        const sessions = db
          .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
          .all() as any[];
        for (const row of sessions) {
          const session: Session = {
            id: row.session_id || row.id,
            project: row.project_path || row.project || "unknown",
            cwd: row.cwd || row.project_path || "",
            startedAt:
              row.created_at || row.started_at || new Date().toISOString(),
            endedAt: row.ended_at || row.updated_at,
            lastCheckpointAt: row.ended_at || row.updated_at,
            status: "completed",
            observationCount: 0,
          };
          await kv.set(KV.sessions, session.id, session);
          sessionCount++;
        }

        let observations: any[] = [];
        try {
          observations = db
            .prepare("SELECT * FROM observations ORDER BY created_at ASC")
            .all() as any[];
        } catch {
          try {
            observations = db
              .prepare(
                "SELECT * FROM compressed_observations ORDER BY created_at ASC",
              )
              .all() as any[];
          } catch {
            logger.warn("No observation tables found");
          }
        }

        for (const row of observations) {
          const sessionId = row.session_id || "migrated";
          const obs: CompressedObservation = {
            id: row.id || generateId("mig"),
            sessionId,
            timestamp: row.created_at || new Date().toISOString(),
            sourceType: row.source_type || row.hook_type || "migration",
            toolName: row.tool_name || undefined,
            type: row.type || "other",
            title: row.title || row.summary || "Migrated observation",
            subtitle: row.subtitle,
            facts: safeJsonParse(row.facts, []),
            narrative: row.narrative || row.content || "",
            concepts: safeJsonParse(row.concepts, []),
            files: safeJsonParse(row.files, []),
            importance: row.importance || 5,
          };
          await kv.set(KV.observations(sessionId), obs.id, obs);
          obsCount++;
        }

        let summaries: any[] = [];
        try {
          summaries = db
            .prepare("SELECT * FROM session_summaries")
            .all() as any[];
        } catch {
          logger.warn("No summaries table found");
        }

        for (const row of summaries) {
          const summary: SessionSummary = {
            sessionId: row.session_id,
            project: row.project || "unknown",
            createdAt: row.created_at || new Date().toISOString(),
            title: row.title || "Migrated session",
            narrative: row.narrative || row.summary || "",
            keyDecisions: safeJsonParse(row.key_decisions, []),
            filesModified: safeJsonParse(row.files_modified, []),
            concepts: safeJsonParse(row.concepts, []),
            observationCount: row.observation_count || 0,
          };
          await kv.set(KV.summaries, row.session_id, summary);
          summaryCount++;
        }

        logger.info("Migration complete", {
          sessionCount,
          obsCount,
          summaryCount,
        });
        return { success: true, sessionCount, obsCount, summaryCount };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Migration failed", { error: msg });
        return { success: false, error: "Migration failed" };
      } finally {
        try {
          if (db) db.close();
        } catch {}
      }
    },
  );
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value)) return value as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}
