import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  Session,
  SessionSummary,
  Memory,
  ProjectProfile,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";

const PROFILE_OBSERVATION_SESSION_LIMIT = 200;

interface FreqEntry {
  label: string;
  buckets: Set<string>;
}

function bumpFreq(
  map: Map<string, FreqEntry>,
  key: string,
  label: string,
  bucket: string,
): void {
  let entry = map.get(key);
  if (!entry) {
    entry = { label, buckets: new Set<string>() };
    map.set(key, entry);
  }
  entry.buckets.add(bucket);
}

function addConcept(
  map: Map<string, FreqEntry>,
  raw: unknown,
  bucket: string,
): void {
  if (typeof raw !== "string") return;
  const label = raw.trim();
  if (!label) return;
  bumpFreq(map, label.toLowerCase(), label, bucket);
}

function isFileUnderProject(file: string, project: string): boolean {
  if (!project.startsWith("/")) return true;
  const base = project.endsWith("/") ? project.slice(0, -1) : project;
  return file === base || file.startsWith(base + "/");
}

function addFile(
  map: Map<string, FreqEntry>,
  raw: unknown,
  bucket: string,
  project: string,
): void {
  if (typeof raw !== "string") return;
  const file = raw.trim();
  if (!file) return;
  if (!isFileUnderProject(file, project)) return;
  bumpFreq(map, file, file, bucket);
}

function extractFilesFromSubtitle(subtitle: string | undefined): string[] {
  if (typeof subtitle !== "string" || !subtitle.startsWith("{")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(subtitle);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const out: string[] = [];
  if (typeof obj.filePath === "string") out.push(obj.filePath);
  for (const key of ["filePaths", "files"] as const) {
    const val = obj[key];
    if (Array.isArray(val)) {
      for (const f of val) if (typeof f === "string") out.push(f);
    }
  }
  return out;
}

function rankFreq(map: Map<string, FreqEntry>): Array<{
  label: string;
  frequency: number;
}> {
  return Array.from(map.values())
    .map((entry) => ({ label: entry.label, frequency: entry.buckets.size }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 15);
}

export function registerProfileFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::profile",
    async (data: { project: string; refresh?: boolean } | undefined) => {
      if (!data || typeof data.project !== "string" || !data.project.trim()) {
        return { success: false, error: "project is required" };
      }
      const project = data.project.trim();

      if (!data.refresh) {
        const cached = await kv
          .get<ProjectProfile>(KV.profiles, project)
          .catch(() => null);
        if (cached) {
          const age = Date.now() - new Date(cached.updatedAt).getTime();
          if (age < 3600_000) {
            return { profile: cached, cached: true };
          }
        }
      }

      const sessions = await kv.list<Session>(KV.sessions);
      const projectSessions = sessions.filter((s) => s.project === project);

      if (projectSessions.length === 0) {
        return { profile: null, reason: "no_sessions" };
      }

      const projectSessionIds = new Set(projectSessions.map((s) => s.id));

      const sortedSessions = projectSessions.sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );

      let sourcesDegraded = false;
      const [allSummaries, allMemories] = await Promise.all([
        kv.list<SessionSummary>(KV.summaries).catch(() => {
          sourcesDegraded = true;
          return [] as SessionSummary[];
        }),
        kv.list<Memory>(KV.memories).catch(() => {
          sourcesDegraded = true;
          return [] as Memory[];
        }),
      ]);

      const projectSummaries = allSummaries.filter(
        (s) => s.project === project,
      );
      const projectMemories = allMemories.filter(
        (m) =>
          m.isLatest !== false &&
          (m.project === project ||
            (m.sessionIds || []).some((id) => projectSessionIds.has(id))),
      );

      const conceptFreq = new Map<string, FreqEntry>();
      const fileFreq = new Map<string, FreqEntry>();
      const errors: string[] = [];
      let scannedObs = 0;

      for (const summary of projectSummaries) {
        const bucket = summary.sessionId;
        for (const concept of summary.concepts || []) {
          addConcept(conceptFreq, concept, bucket);
        }
        for (const file of summary.filesModified || []) {
          addFile(fileFreq, file, bucket, project);
        }
      }

      for (const memory of projectMemories) {
        const linked = (memory.sessionIds || []).filter((id) =>
          projectSessionIds.has(id),
        );
        const buckets = linked.length > 0 ? linked : [`memory:${memory.id}`];
        for (const bucket of buckets) {
          for (const concept of memory.concepts || []) {
            addConcept(conceptFreq, concept, bucket);
          }
          for (const file of memory.files || []) {
            addFile(fileFreq, file, bucket, project);
          }
        }
      }

      const scanSessions = sortedSessions.slice(
        0,
        PROFILE_OBSERVATION_SESSION_LIMIT,
      );
      const obsPerSession = await Promise.all(
        scanSessions.map((s) =>
          kv
            .list<CompressedObservation>(KV.observations(s.id))
            .catch(() => [] as CompressedObservation[]),
        ),
      );

      for (let i = 0; i < scanSessions.length; i++) {
        const bucket = scanSessions[i].id;
        const observations = obsPerSession[i];
        scannedObs += observations.length;

        for (const obs of observations) {
          for (const concept of obs.concepts || []) {
            addConcept(conceptFreq, concept, bucket);
          }
          for (const file of obs.files || []) {
            addFile(fileFreq, file, bucket, project);
          }
          for (const file of extractFilesFromSubtitle(obs.subtitle)) {
            addFile(fileFreq, file, bucket, project);
          }
          if (obs.type === "error") {
            errors.push(obs.title);
          }
        }
      }

      const topConcepts = rankFreq(conceptFreq).map((e) => ({
        concept: e.label,
        frequency: e.frequency,
      }));

      const topFiles = rankFreq(fileFreq).map((e) => ({
        file: e.label,
        frequency: e.frequency,
      }));

      const uniqueErrors = [...new Set(errors)].slice(0, 10);

      const recentActivity = buildRecentActivity(
        projectSummaries,
        scanSessions,
        obsPerSession,
      );

      const sessionObservationTotal = projectSessions.reduce(
        (sum, s) =>
          sum + (typeof s.observationCount === "number" ? s.observationCount : 0),
        0,
      );
      const totalObservations = Math.max(sessionObservationTotal, scannedObs);

      const profile: ProjectProfile = {
        project,
        updatedAt: new Date().toISOString(),
        topConcepts,
        topFiles,
        conventions: extractConventions(topConcepts, topFiles),
        commonErrors: uniqueErrors,
        recentActivity: recentActivity.slice(0, 10),
        sessionCount: projectSessions.length,
        totalObservations,
      };

      if (!sourcesDegraded) {
        await kv.set(KV.profiles, project, profile);
      }
      await recordAudit(kv, "share", "mem::profile", [project], {
        sessionCount: projectSessions.length,
        totalObservations,
      });

      logger.info("Profile generated", {
        project,
        sessions: projectSessions.length,
        observations: totalObservations,
        scanned: scannedObs,
      });
      return { profile, cached: false };
    },
  );
}

function buildRecentActivity(
  summaries: SessionSummary[],
  scanSessions: Session[],
  obsPerSession: CompressedObservation[][],
): string[] {
  if (summaries.length > 0) {
    return [...summaries]
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .map((s) => `[${s.createdAt.slice(0, 10)}] ${s.title}`);
  }

  const activity: string[] = [];
  for (let i = 0; i < scanSessions.length; i++) {
    const important = obsPerSession[i]
      .filter((o) => o.importance >= 7)
      .sort((a, b) => b.importance - a.importance);
    if (important.length > 0) {
      activity.push(
        `[${scanSessions[i].startedAt.slice(0, 10)}] ${important[0].title}`,
      );
    }
  }
  return activity;
}

function extractConventions(
  concepts: Array<{ concept: string; frequency: number }>,
  files: Array<{ file: string; frequency: number }>,
): string[] {
  const conventions: string[] = [];

  const tsFiles = files.filter((f) => f.file.endsWith(".ts")).length;
  const jsFiles = files.filter((f) => f.file.endsWith(".js")).length;
  if (tsFiles > jsFiles && tsFiles > 0) {
    conventions.push("TypeScript project");
  }

  const srcFiles = files.filter((f) => f.file.includes("/src/")).length;
  if (srcFiles > files.length * 0.5) {
    conventions.push("Standard src/ directory structure");
  }

  const testFiles = files.filter(
    (f) => f.file.includes("test") || f.file.includes("spec"),
  ).length;
  if (testFiles > 0) {
    conventions.push("Has test files");
  }

  for (const { concept, frequency } of concepts.slice(0, 5)) {
    if (frequency >= 3) {
      conventions.push(`Frequently uses: ${concept}`);
    }
  }

  return conventions;
}
