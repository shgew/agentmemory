import type { ISdk } from "iii-sdk";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ProjectProfile,
  ExportData,
  GraphNode,
  GraphEdge,
  SemanticMemory,
  ProceduralMemory,
  Action,
  ActionEdge,
  Routine,
  Signal,
  Checkpoint,
  Sentinel,
  Sketch,
  Crystal,
  Facet,
  Lesson,
  Insight,
  AccessLogExport,
  RawObservation,
  PendingImageRelease,
} from "../types.js";
import {
  type AccessTarget,
  deleteAccessLog,
  restoreOwnedAccessLogWithinOwnershipLock,
} from "./access-tracker.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { VERSION } from "../version.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";
import {
  buildSnapshotFromArrays,
  edgeIndexKey,
  nameIndexKey,
} from "./graph.js";
import { SNAPSHOT_KEY } from "../state/graph-snapshot.js";
import {
  flushIndexSave,
  rebuildIndexWithinMaintenance,
  withIndexMaintenance,
} from "./search.js";
import {
  clearPendingCompression,
  markPendingCompression,
  storeRawObservationUnderOwnerLock,
} from "./raw-observations.js";
import { drainPendingImageReleases } from "./image-owner.js";
import {
  withObservationOwnerLock,
  withImageOwnershipLock,
  withObservationSessionLocksWithinOwnershipLock,
} from "./observation-lock.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateImportRows(
  name: string,
  value: unknown,
  maxRows: number,
  requiredFields: string[],
): string | null {
  if (!Array.isArray(value)) return `${name} must be an array`;
  if (value.length > maxRows) return `Too many ${name} (max ${maxRows})`;
  for (let index = 0; index < value.length; index++) {
    const row = value[index];
    if (!isRecord(row)) return `${name}[${index}] must be an object`;
    for (const field of requiredFields) {
      const fieldValue = row[field];
      if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
        return `${name}[${index}].${field} must be a non-empty string`;
      }
    }
  }
  return null;
}

async function clearImportedState(kv: StateKV): Promise<void> {
  const sessions = await kv.list<Session>(KV.sessions);
  const observations = await Promise.all(
    sessions.map(async (session) => ({
      sessionId: session.id,
      rows: await kv.list<CompressedObservation>(KV.observations(session.id)),
    })),
  );
  const pendingCompression = await Promise.all(
    sessions.map(async (session) => ({
      sessionId: session.id,
      rows: await kv.list<{ id: string }>(KV.pendingCompression(session.id)),
    })),
  );
  const [
    rawPayloads,
    memories,
    summaries,
    actions,
    actionEdges,
    routines,
    signals,
    checkpoints,
    sentinels,
    sketches,
    crystals,
    facets,
    lessons,
    insights,
    graphNodes,
    graphEdges,
    graphTombstones,
    semantic,
    procedural,
    profiles,
    accessLogs,
  ] = await Promise.all([
    kv.list<RawObservation>(KV.rawPayloads),
    kv.list<Memory>(KV.memories),
    kv.list<SessionSummary>(KV.summaries),
    kv.list<Action>(KV.actions),
    kv.list<ActionEdge>(KV.actionEdges),
    kv.list<Routine>(KV.routines),
    kv.list<Signal>(KV.signals),
    kv.list<Checkpoint>(KV.checkpoints),
    kv.list<Sentinel>(KV.sentinels),
    kv.list<Sketch>(KV.sketches),
    kv.list<Crystal>(KV.crystals),
    kv.list<Facet>(KV.facets),
    kv.list<Lesson>(KV.lessons),
    kv.list<Insight>(KV.insights),
    kv.list<GraphNode>(KV.graphNodes),
    kv.list<GraphEdge>(KV.graphEdges),
    kv.list<{ id: string }>(KV.graphTombstones),
    kv.list<SemanticMemory>(KV.semantic),
    kv.list<ProceduralMemory>(KV.procedural),
    kv.list<ProjectProfile>(KV.profiles),
    kv.list<AccessLogExport>(KV.accessLog),
  ]);
  const deletedAccessIds = new Set<string>();
  const deleteOwnerAccess = async (id: string) => {
    if (deletedAccessIds.has(id)) return;
    await deleteAccessLog(kv, id);
    deletedAccessIds.add(id);
  };

  const observationOwners = new Map<string, Set<string>>();
  const addObservationOwner = (id: string, sessionId: string) => {
    const sessionIds = observationOwners.get(id) ?? new Set<string>();
    sessionIds.add(sessionId);
    observationOwners.set(id, sessionIds);
  };
  for (const bucket of observations) {
    for (const observation of bucket.rows) {
      addObservationOwner(observation.id, bucket.sessionId);
    }
  }
  for (const row of rawPayloads) addObservationOwner(row.id, row.sessionId);
  for (const bucket of pendingCompression) {
    for (const row of bucket.rows) {
      addObservationOwner(row.id, bucket.sessionId);
    }
  }

  for (const session of sessions) await kv.delete(KV.sessions, session.id);
  for (const [observationId, sessionIds] of observationOwners) {
    await withObservationOwnerLock(observationId, async () => {
      for (const sessionId of sessionIds) {
        await kv.delete(KV.observations(sessionId), observationId);
        await kv.delete(KV.pendingCompression(sessionId), observationId);
      }
      await kv.delete(KV.rawPayloads, observationId);
      await deleteOwnerAccess(observationId);
    });
  }
  for (const row of memories) {
    await kv.delete(KV.memories, row.id);
    await deleteOwnerAccess(row.id);
  }
  for (const row of summaries) await kv.delete(KV.summaries, row.sessionId);
  for (const row of actions) await kv.delete(KV.actions, row.id);
  for (const row of actionEdges) await kv.delete(KV.actionEdges, row.id);
  for (const row of routines) await kv.delete(KV.routines, row.id);
  for (const row of signals) await kv.delete(KV.signals, row.id);
  for (const row of checkpoints) await kv.delete(KV.checkpoints, row.id);
  for (const row of sentinels) await kv.delete(KV.sentinels, row.id);
  for (const row of sketches) await kv.delete(KV.sketches, row.id);
  for (const row of crystals) await kv.delete(KV.crystals, row.id);
  for (const row of facets) await kv.delete(KV.facets, row.id);
  for (const row of lessons) await kv.delete(KV.lessons, row.id);
  for (const row of insights) await kv.delete(KV.insights, row.id);
  for (const row of graphEdges) {
    await kv.delete(KV.graphEdges, row.id);
    await kv.delete(
      KV.graphEdgeKey,
      edgeIndexKey(row.sourceNodeId, row.targetNodeId, row.type),
    );
  }
  for (const row of graphNodes) {
    await kv.delete(KV.graphNodes, row.id);
    await kv.delete(KV.graphNameIndex, nameIndexKey(row.type, row.name));
    await kv.delete(KV.graphNodeDegree, row.id);
  }
  for (const row of graphTombstones) {
    await kv.delete(KV.graphTombstones, row.id);
  }
  await kv.delete(KV.graphSnapshot, SNAPSHOT_KEY);
  for (const row of semantic) {
    await kv.delete(KV.semantic, row.id);
    await deleteOwnerAccess(row.id);
  }
  for (const row of procedural) {
    await kv.delete(KV.procedural, row.id);
    await deleteOwnerAccess(row.id);
  }
  for (const row of profiles) await kv.delete(KV.profiles, row.project);
  for (const row of accessLogs) await deleteOwnerAccess(row.memoryId);
}

async function collectImageReferenceCounts(
  kv: StateKV,
): Promise<Map<string, number>> {
  const [sessions, rawPayloads, memories] = await Promise.all([
    kv.list<Session>(KV.sessions),
    kv.list<RawObservation>(KV.rawPayloads),
    kv.list<Memory>(KV.memories),
  ]);
  const observations = await Promise.all(
    sessions.map((session) =>
      kv.list<CompressedObservation>(KV.observations(session.id)),
    ),
  );
  const owners = new Map<string, Set<string>>();
  const add = (owner: string, value: unknown) => {
    if (typeof value !== "string" || value.length === 0) return;
    const refs = owners.get(owner) ?? new Set<string>();
    refs.add(value);
    owners.set(owner, refs);
  };
  for (const raw of rawPayloads) add(`observation:${raw.id}`, raw.imageData);
  for (const bucket of observations) {
    for (const observation of bucket) {
      const owner = `observation:${observation.id}`;
      add(owner, observation.imageData);
      add(owner, observation.imageRef);
    }
  }
  for (const memory of memories) {
    const owner = `memory:${memory.id}`;
    add(owner, memory.imageData);
    add(owner, memory.imageRef);
  }
  const counts = new Map<string, number>();
  for (const refs of owners.values()) {
    for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return counts;
}

async function rebuildImageReferenceCounts(
  sdk: ISdk,
  kv: StateKV,
  previousRefs: ReadonlySet<string>,
): Promise<number> {
  const counts = await collectImageReferenceCounts(kv);
  await Promise.all(
    Array.from(counts, ([ref, count]) => kv.set(KV.imageRefs, ref, count)),
  );
  const orphanedRefs = [...previousRefs].filter((ref) => !counts.has(ref));
  if (orphanedRefs.length > 0) {
    const { decrementImageRef } = await import("./image-refs.js");
    for (const ref of orphanedRefs) {
      await kv.set(KV.imageRefs, ref, 1);
      await decrementImageRef(kv, sdk, ref);
    }
  }
  return counts.size;
}

async function rebuildImportedGraphState(kv: StateKV): Promise<void> {
  const [nodes, edges] = await Promise.all([
    kv.list<GraphNode>(KV.graphNodes),
    kv.list<GraphEdge>(KV.graphEdges),
  ]);
  const liveNodes = nodes.filter((node) => !node.stale);
  const liveEdges = edges.filter((edge) => !edge.stale);
  const degrees = new Map<string, number>();
  for (const edge of liveEdges) {
    degrees.set(edge.sourceNodeId, (degrees.get(edge.sourceNodeId) ?? 0) + 1);
    degrees.set(edge.targetNodeId, (degrees.get(edge.targetNodeId) ?? 0) + 1);
  }
  const batchSize = 100;
  for (let offset = 0; offset < liveNodes.length; offset += batchSize) {
    await Promise.all(
      liveNodes
        .slice(offset, offset + batchSize)
        .flatMap((node) => [
          kv.set(
            KV.graphNameIndex,
            nameIndexKey(node.type, node.name),
            node.id,
          ),
          kv.set(KV.graphNodeDegree, node.id, degrees.get(node.id) ?? 0),
        ]),
    );
  }
  for (let offset = 0; offset < liveEdges.length; offset += batchSize) {
    await Promise.all(
      liveEdges
        .slice(offset, offset + batchSize)
        .map((edge) =>
          kv.set(
            KV.graphEdgeKey,
            edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type),
            edge.id,
          ),
        ),
    );
  }
  await kv.set(
    KV.graphSnapshot,
    SNAPSHOT_KEY,
    buildSnapshotFromArrays(nodes, edges),
  );
}

export function registerExportImportFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::export",
    async (data?: { maxSessions?: number; offset?: number }) => {
      const rawMax = Number(data?.maxSessions);
      const maxSessions =
        Number.isFinite(rawMax) && rawMax > 0
          ? Math.min(Math.floor(rawMax), 1000)
          : undefined;
      const rawOffset = Number(data?.offset);
      const offset =
        Number.isFinite(rawOffset) && rawOffset >= 0
          ? Math.floor(rawOffset)
          : 0;

      const allSessions = await kv.list<Session>(KV.sessions);
      const paginatedSessions =
        maxSessions !== undefined
          ? allSessions.slice(offset, offset + maxSessions)
          : allSessions;
      const memories = await kv.list<Memory>(KV.memories);
      const summaries = await kv.list<SessionSummary>(KV.summaries);

      const observations: Record<string, CompressedObservation[]> = {};
      const obsResults = await Promise.all(
        paginatedSessions.map((session) =>
          kv
            .list<CompressedObservation>(KV.observations(session.id))
            .then((obs) => ({ sessionId: session.id, obs })),
        ),
      );
      for (const { sessionId, obs } of obsResults) {
        if (obs.length > 0) {
          observations[sessionId] = obs;
        }
      }
      const exportedSessionIds = new Set(
        paginatedSessions.map((session) => session.id),
      );
      const rawPayloads = (
        await kv.list<RawObservation>(KV.rawPayloads)
      ).filter((raw) => exportedSessionIds.has(raw.sessionId));

      const profiles: ProjectProfile[] = [];
      const uniqueProjects = [
        ...new Set(paginatedSessions.map((s) => s.project)),
      ];
      const profileResults = await Promise.all(
        uniqueProjects.map((project) =>
          kv.get<ProjectProfile>(KV.profiles, project),
        ),
      );
      for (const profile of profileResults) {
        if (profile) profiles.push(profile);
      }

      const [
        graphNodes,
        graphEdges,
        semanticMemories,
        proceduralMemories,
        actions,
        actionEdges,
        sentinels,
        sketches,
        crystals,
        facets,
        lessons,
        insights,
        routines,
        signals,
        checkpoints,
        accessLogs,
      ] = await Promise.all([
        kv.list<GraphNode>(KV.graphNodes),
        kv.list<GraphEdge>(KV.graphEdges),
        kv.list<SemanticMemory>(KV.semantic),
        kv.list<ProceduralMemory>(KV.procedural),
        kv.list<Action>(KV.actions),
        kv.list<ActionEdge>(KV.actionEdges),
        kv.list<Sentinel>(KV.sentinels),
        kv.list<Sketch>(KV.sketches),
        kv.list<Crystal>(KV.crystals),
        kv.list<Facet>(KV.facets),
        kv.list<Lesson>(KV.lessons),
        kv.list<Insight>(KV.insights),
        kv.list<Routine>(KV.routines),
        kv.list<Signal>(KV.signals),
        kv.list<Checkpoint>(KV.checkpoints),
        kv.list<AccessLogExport>(KV.accessLog),
      ]);
      const exportedAccessOwnerIds = new Set([
        ...memories.map((memory) => memory.id),
        ...semanticMemories.map((memory) => memory.id),
        ...proceduralMemories.map((memory) => memory.id),
        ...lessons.map((lesson) => lesson.id),
        ...Object.values(observations).flatMap((rows) =>
          rows.map((observation) => observation.id),
        ),
      ]);
      const exportedAccessLogs = accessLogs.filter((log) =>
        exportedAccessOwnerIds.has(log.memoryId),
      );

      const exportData: ExportData = {
        version: VERSION,
        exportedAt: new Date().toISOString(),
        sessions: paginatedSessions,
        observations,
        rawPayloads: rawPayloads.length > 0 ? rawPayloads : undefined,
        memories,
        summaries,
        profiles: profiles.length > 0 ? profiles : undefined,
        graphNodes: graphNodes.length > 0 ? graphNodes : undefined,
        graphEdges: graphEdges.length > 0 ? graphEdges : undefined,
        semanticMemories:
          semanticMemories.length > 0 ? semanticMemories : undefined,
        proceduralMemories:
          proceduralMemories.length > 0 ? proceduralMemories : undefined,
        actions: actions.length > 0 ? actions : undefined,
        actionEdges: actionEdges.length > 0 ? actionEdges : undefined,
        sentinels: sentinels.length > 0 ? sentinels : undefined,
        sketches: sketches.length > 0 ? sketches : undefined,
        crystals: crystals.length > 0 ? crystals : undefined,
        facets: facets.length > 0 ? facets : undefined,
        lessons: lessons.length > 0 ? lessons : undefined,
        insights: insights.length > 0 ? insights : undefined,
        routines: routines.length > 0 ? routines : undefined,
        signals: signals.length > 0 ? signals : undefined,
        checkpoints: checkpoints.length > 0 ? checkpoints : undefined,
        accessLogs:
          exportedAccessLogs.length > 0 ? exportedAccessLogs : undefined,
      };

      if (maxSessions !== undefined) {
        exportData.pagination = {
          offset,
          limit: maxSessions,
          total: allSessions.length,
          hasMore: offset + maxSessions < allSessions.length,
        };
      }

      const totalObs = Object.values(observations).reduce(
        (sum, arr) => sum + arr.length,
        0,
      );
      logger.info("Export complete", {
        sessions: paginatedSessions.length,
        totalSessions: allSessions.length,
        observations: totalObs,
        memories: memories.length,
        summaries: summaries.length,
      });

      return exportData;
    },
  );

  sdk.registerFunction(
    "mem::import",
    (data: {
      exportData: ExportData;
      strategy?: "merge" | "replace" | "skip";
    }) =>
      withKeyedLock("import:all", async () => {
        if (
          !data?.exportData ||
          typeof data.exportData !== "object" ||
          typeof (data.exportData as { version?: unknown }).version !== "string"
        ) {
          return {
            success: false,
            error: "exportData with string version is required",
          };
        }
        const strategy = data.strategy || "merge";
        if (!["merge", "replace", "skip"].includes(strategy)) {
          return {
            success: false,
            error: "strategy must be merge, replace, or skip",
          };
        }
        const importData = data.exportData;

        const supportedVersions = new Set([
          "0.3.0",
          "0.4.0",
          "0.5.0",
          "0.6.0",
          "0.6.1",
          "0.7.0",
          "0.7.2",
          "0.7.3",
          "0.7.4",
          "0.7.5",
          "0.7.6",
          "0.7.7",
          "0.7.9",
          "0.8.0",
          "0.8.1",
          "0.8.2",
          "0.8.3",
          "0.8.4",
          "0.8.5",
          "0.8.6",
          "0.8.7",
          "0.8.8",
          "0.8.9",
          "0.8.10",
          "0.8.11",
          "0.8.12",
          "0.8.13",
          "0.9.0",
          "0.9.1",
          "0.9.2",
          "0.9.3",
          "0.9.4",
          "0.9.5",
          "0.9.6",
          "0.9.7",
          "0.9.8",
          "0.9.9",
          "0.9.10",
          "0.9.11",
          "0.9.12",
          "0.9.13",
          "0.9.14",
          "0.9.15",
          "0.9.16",
          "0.9.17",
          "0.9.18",
          "0.9.19",
          "0.9.20",
          "0.9.21",
          "0.9.22",
          "0.9.23",
          "0.9.24",
          "0.9.25",
          "0.9.26",
          "0.9.27",
        ]);
        if (!supportedVersions.has(importData.version)) {
          return {
            success: false,
            error: `Unsupported export version: ${importData.version}`,
          };
        }

        if (strategy === "replace" && importData.pagination !== undefined) {
          const pagination = importData.pagination as unknown;
          const isCompletePage =
            isRecord(pagination) &&
            pagination.offset === 0 &&
            typeof pagination.limit === "number" &&
            Number.isSafeInteger(pagination.limit) &&
            pagination.limit > 0 &&
            typeof pagination.total === "number" &&
            Number.isSafeInteger(pagination.total) &&
            pagination.total >= 0 &&
            pagination.hasMore === false &&
            Array.isArray(importData.sessions) &&
            pagination.total === importData.sessions.length &&
            pagination.limit >= pagination.total;
          if (!isCompletePage) {
            return {
              success: false,
              error: "replace requires an export containing all sessions",
            };
          }
        }

        const MAX_SESSIONS = 10_000;
        const MAX_MEMORIES = 50_000;
        const MAX_SUMMARIES = 10_000;
        const MAX_OBS_PER_SESSION = 5_000;
        const MAX_TOTAL_OBSERVATIONS = 500_000;
        const MAX_ACCESS_LOGS = 50_000;
        const MAX_RAW_PAYLOADS = 500_000;

        const requiredCollections = [
          ["sessions", importData.sessions, MAX_SESSIONS, ["id", "project"]],
          ["memories", importData.memories, MAX_MEMORIES, ["id"]],
          ["summaries", importData.summaries, MAX_SUMMARIES, ["sessionId"]],
          [
            "rawPayloads",
            importData.rawPayloads ?? [],
            MAX_RAW_PAYLOADS,
            ["id", "sessionId"],
          ],
        ] as const;
        for (const [name, value, maxRows, fields] of requiredCollections) {
          const error = validateImportRows(name, value, maxRows, [...fields]);
          if (error) return { success: false, error };
        }

        if (!isRecord(importData.observations)) {
          return { success: false, error: "observations must be an object" };
        }

        const MAX_OBS_BUCKETS = 10_000;
        const obsBuckets = Object.keys(importData.observations);
        if (obsBuckets.length > MAX_OBS_BUCKETS) {
          return {
            success: false,
            error: `Too many observation buckets (max ${MAX_OBS_BUCKETS})`,
          };
        }

        let totalObservations = 0;
        const compressedObservationSessions = new Map<string, string>();
        for (const [sessionId, obs] of Object.entries(
          importData.observations,
        )) {
          if (!sessionId.trim()) {
            return {
              success: false,
              error: "observation bucket ids must be non-empty",
            };
          }
          const error = validateImportRows(
            `observations.${sessionId}`,
            obs,
            MAX_OBS_PER_SESSION,
            ["id", "sessionId"],
          );
          if (error) return { success: false, error };
          if (obs.some((observation) => observation.sessionId !== sessionId)) {
            return {
              success: false,
              error: `observations.${sessionId} contains a mismatched sessionId`,
            };
          }
          for (const observation of obs) {
            if (compressedObservationSessions.has(observation.id)) {
              return {
                success: false,
                error: `duplicate observation id ${observation.id}`,
              };
            }
            compressedObservationSessions.set(observation.id, sessionId);
          }
          totalObservations += obs.length;
        }
        if (totalObservations > MAX_TOTAL_OBSERVATIONS) {
          return {
            success: false,
            error: `Too many total observations (max ${MAX_TOTAL_OBSERVATIONS})`,
          };
        }

        const rawPayloads = importData.rawPayloads ?? [];
        const rawObservationIds = new Set<string>();
        const importedObservationSessions = new Map(
          compressedObservationSessions,
        );
        for (const raw of rawPayloads) {
          if (rawObservationIds.has(raw.id)) {
            return {
              success: false,
              error: `duplicate raw payload id ${raw.id}`,
            };
          }
          rawObservationIds.add(raw.id);
          const compressedSessionId = compressedObservationSessions.get(raw.id);
          if (
            compressedSessionId !== undefined &&
            compressedSessionId !== raw.sessionId
          ) {
            return {
              success: false,
              error: `observation ${raw.id} has conflicting session ids`,
            };
          }
          importedObservationSessions.set(raw.id, raw.sessionId);
        }

        const optionalCollections = [
          ["profiles", 10_000, ["project"]],
          ["graphNodes", 500_000, ["id", "type", "name"]],
          [
            "graphEdges",
            500_000,
            ["id", "sourceNodeId", "targetNodeId", "type"],
          ],
          ["semanticMemories", 100_000, ["id"]],
          ["proceduralMemories", 100_000, ["id"]],
          ["actions", 100_000, ["id"]],
          ["actionEdges", 100_000, ["id"]],
          ["routines", 100_000, ["id"]],
          ["signals", 100_000, ["id"]],
          ["checkpoints", 100_000, ["id"]],
          ["sentinels", 100_000, ["id"]],
          ["sketches", 100_000, ["id"]],
          ["crystals", 100_000, ["id"]],
          ["facets", 100_000, ["id"]],
          ["lessons", 100_000, ["id"]],
          ["insights", 100_000, ["id"]],
          ["accessLogs", MAX_ACCESS_LOGS, ["memoryId"]],
        ] as const;
        const importRecord = importData as unknown as Record<string, unknown>;
        for (const [name, maxRows, fields] of optionalCollections) {
          const value = importRecord[name];
          if (value === undefined) continue;
          const error = validateImportRows(name, value, maxRows, [...fields]);
          if (error) return { success: false, error };
        }

        return withIndexMaintenance(async () => {
          await drainPendingImageReleases(sdk, kv);
          const ownershipResult = await withImageOwnershipLock(async () => {
            const currentSessions = await kv.list<Session>(KV.sessions);
            const sessionIds = new Set(
              importData.sessions.map((session) => session.id),
            );
            for (const sessionId of obsBuckets) sessionIds.add(sessionId);
            for (const raw of rawPayloads) sessionIds.add(raw.sessionId);
            for (const session of currentSessions) sessionIds.add(session.id);

            return withObservationSessionLocksWithinOwnershipLock(
              sessionIds,
              async () => {
                const availableSessionIds = new Set(
                  importData.sessions.map((session) => session.id),
                );
                if (strategy !== "replace") {
                  for (const session of currentSessions) {
                    availableSessionIds.add(session.id);
                  }
                }
                const unavailableObservationSession = obsBuckets.find(
                  (sessionId) => !availableSessionIds.has(sessionId),
                );
                if (unavailableObservationSession) {
                  return {
                    success: false as const,
                    error: `observation bucket references unavailable session ${unavailableObservationSession}`,
                  };
                }
                const unavailableRawSession = rawPayloads.find(
                  (raw) => !availableSessionIds.has(raw.sessionId),
                );
                if (unavailableRawSession) {
                  return {
                    success: false as const,
                    error: `rawPayloads references unavailable session ${unavailableRawSession.sessionId}`,
                  };
                }
                if (strategy !== "replace") {
                  for (
                    let offset = 0;
                    offset < currentSessions.length;
                    offset += 10
                  ) {
                    const sessions = currentSessions.slice(offset, offset + 10);
                    const observationBuckets = await Promise.all(
                      sessions.map((session) =>
                        kv.list<CompressedObservation>(
                          KV.observations(session.id),
                        ),
                      ),
                    );
                    for (let index = 0; index < sessions.length; index++) {
                      for (const observation of observationBuckets[index]) {
                        const importedSessionId =
                          importedObservationSessions.get(observation.id);
                        if (
                          importedSessionId !== undefined &&
                          importedSessionId !== sessions[index].id
                        ) {
                          return {
                            success: false as const,
                            error: `observation ${observation.id} already belongs to session ${sessions[index].id}`,
                          };
                        }
                      }
                    }
                  }
                  for (const [
                    observationId,
                    sessionId,
                  ] of importedObservationSessions) {
                    const existingRaw = await kv.get<RawObservation>(
                      KV.rawPayloads,
                      observationId,
                    );
                    if (existingRaw && existingRaw.sessionId !== sessionId) {
                      return {
                        success: false as const,
                        error: `observation ${observationId} already belongs to session ${existingRaw.sessionId}`,
                      };
                    }
                  }
                }

                const pendingImageReleases = await kv.list<PendingImageRelease>(
                  KV.imageReleases,
                );
                if (pendingImageReleases.length > 0) {
                  return {
                    success: false,
                    error: "pending image releases must complete before import",
                  };
                }
                const stats = {
                  sessions: 0,
                  observations: 0,
                  rawPayloads: 0,
                  memories: 0,
                  summaries: 0,
                  skipped: 0,
                };
                const previousImageRefs = new Set(
                  (await collectImageReferenceCounts(kv)).keys(),
                );

                if (strategy === "replace") await clearImportedState(kv);

                for (const session of importData.sessions) {
                  if (strategy === "skip") {
                    const existing = await kv
                      .get<Session>(KV.sessions, session.id)
                      .catch(() => null);
                    if (existing) {
                      stats.skipped++;
                      continue;
                    }
                  }
                  await kv.set(KV.sessions, session.id, session);
                  stats.sessions++;
                }

                const observationOwners = new Map<
                  string,
                  {
                    observations: CompressedObservation[];
                    rawPayloads: RawObservation[];
                  }
                >();
                const getObservationOwner = (id: string) => {
                  const existing = observationOwners.get(id);
                  if (existing) return existing;
                  const owner = {
                    observations: [] as CompressedObservation[],
                    rawPayloads: [] as RawObservation[],
                  };
                  observationOwners.set(id, owner);
                  return owner;
                };
                for (const observations of Object.values(
                  importData.observations,
                )) {
                  for (const observation of observations) {
                    getObservationOwner(observation.id).observations.push(
                      observation,
                    );
                  }
                }
                for (const raw of importData.rawPayloads ?? []) {
                  getObservationOwner(raw.id).rawPayloads.push(raw);
                }
                for (const [observationId, owner] of observationOwners) {
                  await withObservationOwnerLock(observationId, async () => {
                    for (const observation of owner.observations) {
                      if (strategy === "skip") {
                        const existing = await kv
                          .get<CompressedObservation>(
                            KV.observations(observation.sessionId),
                            observation.id,
                          )
                          .catch(() => null);
                        if (existing) {
                          stats.skipped++;
                          continue;
                        }
                      }
                      await kv.set(
                        KV.observations(observation.sessionId),
                        observation.id,
                        observation,
                      );
                      stats.observations++;
                    }

                    for (const raw of owner.rawPayloads) {
                      let importedRaw = raw;
                      if (strategy === "skip") {
                        const existing = await kv
                          .get<RawObservation>(KV.rawPayloads, raw.id)
                          .catch(() => null);
                        if (existing) {
                          importedRaw = existing;
                          stats.skipped++;
                        } else {
                          await storeRawObservationUnderOwnerLock(kv, raw);
                          stats.rawPayloads++;
                        }
                      } else {
                        await storeRawObservationUnderOwnerLock(kv, raw);
                        stats.rawPayloads++;
                      }
                      const compressed = await kv.get<CompressedObservation>(
                        KV.observations(importedRaw.sessionId),
                        importedRaw.id,
                      );
                      if (compressed?.title) {
                        await clearPendingCompression(
                          kv,
                          importedRaw.sessionId,
                          importedRaw.id,
                        );
                      } else {
                        await markPendingCompression(kv, importedRaw);
                      }
                    }
                  });
                }

                for (const memory of importData.memories) {
                  if (strategy === "skip") {
                    const existing = await kv
                      .get<Memory>(KV.memories, memory.id)
                      .catch(() => null);
                    if (existing) {
                      stats.skipped++;
                      continue;
                    }
                  }
                  const normalizedMemory = Array.isArray(memory.sessionIds)
                    ? memory
                    : { ...memory, sessionIds: [] };
                  await kv.set(KV.memories, memory.id, normalizedMemory);
                  stats.memories++;
                }

                for (const summary of importData.summaries) {
                  if (strategy === "skip") {
                    const existing = await kv
                      .get<SessionSummary>(KV.summaries, summary.sessionId)
                      .catch(() => null);
                    if (existing) {
                      stats.skipped++;
                      continue;
                    }
                  }
                  await kv.set(KV.summaries, summary.sessionId, summary);
                  stats.summaries++;
                }

                if (importData.graphNodes) {
                  for (const node of importData.graphNodes) {
                    const existing = await kv
                      .get<GraphNode>(KV.graphNodes, node.id)
                      .catch(() => null);
                    if (strategy === "skip" && existing) {
                      stats.skipped++;
                      continue;
                    }
                    if (
                      existing &&
                      nameIndexKey(existing.type, existing.name) !==
                        nameIndexKey(node.type, node.name)
                    ) {
                      await kv.delete(
                        KV.graphNameIndex,
                        nameIndexKey(existing.type, existing.name),
                      );
                    }
                    await kv.set(KV.graphNodes, node.id, node);
                    await kv.delete(KV.graphTombstones, node.id);
                  }
                }
                if (importData.graphEdges) {
                  for (const edge of importData.graphEdges) {
                    const existing = await kv
                      .get<GraphEdge>(KV.graphEdges, edge.id)
                      .catch(() => null);
                    if (strategy === "skip" && existing) {
                      stats.skipped++;
                      continue;
                    }
                    if (
                      existing &&
                      edgeIndexKey(
                        existing.sourceNodeId,
                        existing.targetNodeId,
                        existing.type,
                      ) !==
                        edgeIndexKey(
                          edge.sourceNodeId,
                          edge.targetNodeId,
                          edge.type,
                        )
                    ) {
                      await kv.delete(
                        KV.graphEdgeKey,
                        edgeIndexKey(
                          existing.sourceNodeId,
                          existing.targetNodeId,
                          existing.type,
                        ),
                      );
                    }
                    await kv.set(KV.graphEdges, edge.id, edge);
                    await kv.delete(KV.graphTombstones, edge.id);
                  }
                }
                if (importData.semanticMemories) {
                  for (const sem of importData.semanticMemories) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.semantic, sem.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.semantic, sem.id, sem);
                  }
                }
                if (importData.proceduralMemories) {
                  for (const proc of importData.proceduralMemories) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.procedural, proc.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.procedural, proc.id, proc);
                  }
                }
                if (importData.profiles) {
                  for (const profile of importData.profiles) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get<ProjectProfile>(KV.profiles, profile.project)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.profiles, profile.project, profile);
                  }
                }

                if (importData.actions) {
                  for (const action of importData.actions) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.actions, action.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.actions, action.id, action);
                  }
                }
                if (importData.actionEdges) {
                  for (const edge of importData.actionEdges) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.actionEdges, edge.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.actionEdges, edge.id, edge);
                  }
                }
                if (importData.routines) {
                  for (const routine of importData.routines) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.routines, routine.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.routines, routine.id, routine);
                  }
                }
                if (importData.signals) {
                  for (const signal of importData.signals) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.signals, signal.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.signals, signal.id, signal);
                  }
                }
                if (importData.checkpoints) {
                  for (const checkpoint of importData.checkpoints) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.checkpoints, checkpoint.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.checkpoints, checkpoint.id, checkpoint);
                  }
                }
                if (importData.sentinels) {
                  for (const sentinel of importData.sentinels) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.sentinels, sentinel.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.sentinels, sentinel.id, sentinel);
                  }
                }
                if (importData.sketches) {
                  for (const sketch of importData.sketches) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.sketches, sketch.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.sketches, sketch.id, sketch);
                  }
                }
                if (importData.crystals) {
                  for (const crystal of importData.crystals) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.crystals, crystal.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.crystals, crystal.id, crystal);
                  }
                }
                if (importData.facets) {
                  for (const facet of importData.facets) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.facets, facet.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.facets, facet.id, facet);
                  }
                }
                if (importData.lessons) {
                  for (const lesson of importData.lessons) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.lessons, lesson.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.lessons, lesson.id, lesson);
                  }
                }
                if (importData.insights) {
                  for (const insight of importData.insights) {
                    if (strategy === "skip") {
                      const existing = await kv
                        .get(KV.insights, insight.id)
                        .catch(() => null);
                      if (existing) {
                        stats.skipped++;
                        continue;
                      }
                    }
                    await kv.set(KV.insights, insight.id, insight);
                  }
                }
                if (importData.accessLogs) {
                  if (!Array.isArray(importData.accessLogs)) {
                    return {
                      success: false,
                      error: "accessLogs must be an array",
                    };
                  }
                  if (importData.accessLogs.length > MAX_ACCESS_LOGS) {
                    return {
                      success: false,
                      error: `Too many access logs (max ${MAX_ACCESS_LOGS})`,
                    };
                  }
                  const accessTargets = new Map<string, AccessTarget>();
                  for (const memory of importData.memories) {
                    accessTargets.set(memory.id, {
                      id: memory.id,
                      scope: "memory",
                    });
                  }
                  for (const memory of importData.semanticMemories ?? []) {
                    accessTargets.set(memory.id, {
                      id: memory.id,
                      scope: "semantic",
                    });
                  }
                  for (const memory of importData.proceduralMemories ?? []) {
                    accessTargets.set(memory.id, {
                      id: memory.id,
                      scope: "procedural",
                    });
                  }
                  for (const lesson of importData.lessons ?? []) {
                    accessTargets.set(lesson.id, {
                      id: lesson.id,
                      scope: "lesson",
                    });
                  }
                  for (const rows of Object.values(importData.observations)) {
                    for (const observation of rows) {
                      accessTargets.set(observation.id, {
                        id: observation.id,
                        scope: "observation",
                        sessionId: observation.sessionId,
                      });
                    }
                  }
                  for (const raw of importData.accessLogs) {
                    const memoryId = raw.memoryId;
                    const target = accessTargets.get(memoryId);
                    if (!target) continue;
                    if (
                      strategy === "skip" &&
                      (await kv.get(KV.accessLog, memoryId).catch(() => null))
                    ) {
                      stats.skipped++;
                      continue;
                    }
                    await restoreOwnedAccessLogWithinOwnershipLock(
                      kv,
                      target,
                      raw,
                    );
                  }
                }

                if (
                  strategy === "replace" ||
                  (importData.graphNodes?.length ?? 0) > 0 ||
                  (importData.graphEdges?.length ?? 0) > 0
                ) {
                  await rebuildImportedGraphState(kv);
                }
                const imageRefs = await rebuildImageReferenceCounts(
                  sdk,
                  kv,
                  previousImageRefs,
                );
                return { success: true as const, imageRefs, stats };
              },
            );
          });
          if (!ownershipResult.success) return ownershipResult;
          const { imageRefs, stats } = ownershipResult;
          const indexEntries = await rebuildIndexWithinMaintenance(kv, {
            strict: true,
          });
          await flushIndexSave();

          logger.info("Import complete", {
            strategy,
            imageRefs,
            indexEntries,
            ...stats,
          });
          await recordAudit(kv, "import", "mem::import", [], {
            strategy,
            imageRefs,
            indexEntries,
            stats,
          });
          return {
            success: true,
            strategy,
            imageRefs,
            indexEntries,
            ...stats,
          };
        });
      }),
  );
}
