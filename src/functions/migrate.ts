import type { ISdk } from "iii-sdk";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { KV, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import type {
  Memory,
  ProjectProfile,
  Session,
  CompressedObservation,
  SessionSummary,
} from "../types.js";
import { logger } from "../logger.js";
import { recordAudit } from "./audit.js";

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

// Infer memory project from the majority project of its associated sessions.
// Returns { updated, skipped } — safe to run repeatedly (idempotent).
export async function inferMemoryProjects(
  kv: StateKV,
  dryRun = false,
): Promise<{ updated: number; skipped: number; ambiguous: number }> {
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

  for (const memory of memories) {
    if (memory.project) {
      skipped++;
      continue;
    }

    const sessionIds = memory.sessionIds ?? [];
    if (sessionIds.length === 0) {
      ambiguous++;
      continue;
    }

    const projects: string[] = [];
    for (const sid of sessionIds) {
      const session = await loadSession(sid);
      if (session?.project) projects.push(session.project);
    }

    if (projects.length === 0) {
      ambiguous++;
      continue;
    }

    // Majority-vote: count frequency of each project value.
    const freq = new Map<string, number>();
    for (const p of projects) freq.set(p, (freq.get(p) ?? 0) + 1);
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const [topProject, topCount] = sorted[0];

    // Require a strict majority (> 50%) to avoid misattributing a memory
    // that was genuinely built from sessions across multiple projects.
    if (topCount <= projects.length / 2 && sorted.length > 1) {
      ambiguous++;
      continue;
    }

    if (!dryRun) {
      memory.project = topProject;
      await kv.set(KV.memories, memory.id, memory);
    }
    updated++;
  }

  logger.info("inferMemoryProjects complete", { updated, skipped, ambiguous, dryRun });
  return { updated, skipped, ambiguous };
}

function emptyScopeReport(): ScopeReport {
  return { wouldUpdate: 0, alreadyCanonical: 0, noMatch: 0, unscoped: 0 };
}

export type MappingValidation =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

export function validateMapping(mapping: unknown): MappingValidation {
  if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) {
    return {
      ok: false,
      error: "mapping must be a plain object of string keys to string values",
    };
  }
  const obj = mapping as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k.trim().length === 0) {
      return { ok: false, error: "mapping keys must be non-empty strings" };
    }
    if (typeof v !== "string" || v.trim().length === 0) {
      return {
        ok: false,
        error: `mapping value for "${k}" must be a non-empty string`,
      };
    }
  }
  return { ok: true, value: obj as Record<string, string> };
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
