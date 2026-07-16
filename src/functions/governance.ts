import type { ISdk } from "iii-sdk";
import type {
  Memory,
  GovernanceFilter,
  AuditEntry,
  CompressedObservation,
  RawObservation,
  Session,
  PendingImageRelease,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit, safeAudit, queryAudit } from "./audit.js";
import {
  deleteImageBackedRecord,
  deleteObservationOwners,
  type ImageDeletionBatch,
  withImageDeletionBatch,
} from "./image-owner.js";
import { logger } from "../logger.js";

async function locateObservationSession(
  kv: StateKV,
  id: string,
  raw: RawObservation | null,
): Promise<string | null> {
  if (raw) return raw.sessionId;

  const pendingRelease = (
    await kv.list<PendingImageRelease>(KV.imageReleases)
  ).find(
    (release) => release.kind === "observation" && release.observationId === id,
  );
  if (pendingRelease?.sessionId) return pendingRelease.sessionId;

  const sessions = await kv.list<Session>(KV.sessions);
  for (let offset = 0; offset < sessions.length; offset += 25) {
    const batch = sessions.slice(offset, offset + 25);
    const observations = await Promise.all(
      batch.map((session) =>
        kv.get<CompressedObservation>(KV.observations(session.id), id),
      ),
    );
    const index = observations.findIndex((observation) => observation !== null);
    if (index >= 0) return batch[index].id;
  }

  return null;
}

async function deleteObservation(
  sdk: ISdk,
  kv: StateKV,
  id: string,
  raw: RawObservation | null,
  batch?: ImageDeletionBatch,
): Promise<boolean> {
  const sessionId = await locateObservationSession(kv, id, raw);
  if (!sessionId) return false;

  const deleted = await deleteObservationOwners<CompressedObservation>(
    sdk,
    kv,
    sessionId,
    id,
    batch,
  );
  if (!deleted) return false;

  return true;
}

export function registerGovernanceFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::governance-delete",
    async (data: { memoryIds: string[]; reason?: string }) => {
      if (
        !data.memoryIds ||
        !Array.isArray(data.memoryIds) ||
        data.memoryIds.length === 0
      ) {
        return { success: false, error: "memoryIds array is required" };
      }

      const deleted = await withImageDeletionBatch(kv, async (batch) => {
        let count = 0;
        for (const id of data.memoryIds) {
          const mem = await deleteImageBackedRecord<Memory>(
            sdk,
            kv,
            KV.memories,
            id,
            batch,
          );
          if (mem) {
            count++;
            continue;
          }

          const raw = await kv.get<RawObservation>(KV.rawPayloads, id);
          if (await deleteObservation(sdk, kv, id, raw, batch)) {
            count++;
          }
        }
        return count;
      });

      await recordAudit(
        kv,
        "delete",
        "mem::governance-delete",
        data.memoryIds,
        {
          reason: data.reason || "manual deletion",
          deleted,
        },
      );

      logger.info("Governance delete", {
        requested: data.memoryIds.length,
        deleted,
      });
      return { success: true, deleted, total: data.memoryIds.length };
    },
  );

  sdk.registerFunction(
    "mem::governance-bulk",
    async (data: GovernanceFilter & { dryRun?: boolean }) => {
      const hasFilter =
        (data.type && data.type.length > 0) ||
        data.dateFrom ||
        data.dateTo ||
        data.qualityBelow !== undefined;
      if (!hasFilter && !data.dryRun) {
        return {
          success: false,
          error: "At least one filter is required for non-dryRun bulk delete",
        };
      }

      const memories = await kv.list<Memory>(KV.memories);
      let candidates = memories;

      if (data.type && data.type.length > 0) {
        candidates = candidates.filter((m) => data.type!.includes(m.type));
      }
      if (data.dateFrom) {
        const from = new Date(data.dateFrom).getTime();
        if (Number.isNaN(from)) {
          return { success: false, error: "Invalid dateFrom format" };
        }
        candidates = candidates.filter(
          (m) => new Date(m.createdAt).getTime() >= from,
        );
      }
      if (data.dateTo) {
        const to = new Date(data.dateTo).getTime();
        if (Number.isNaN(to)) {
          return { success: false, error: "Invalid dateTo format" };
        }
        candidates = candidates.filter(
          (m) => new Date(m.createdAt).getTime() <= to,
        );
      }
      if (data.qualityBelow !== undefined) {
        candidates = candidates.filter((m) => m.strength < data.qualityBelow!);
      }

      if (data.dryRun) {
        return {
          success: true,
          dryRun: true,
          wouldDelete: candidates.length,
          ids: candidates.map((m) => m.id),
        };
      }

      const BATCH_SIZE = 50;
      const successfulIds: string[] = [];
      const failures: Array<{ id: string; error: string }> = [];
      await withImageDeletionBatch(kv, async (deletionBatch) => {
        for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
          const batch = candidates.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map(async (mem) => {
              const deleted = await deleteImageBackedRecord<Memory>(
                sdk,
                kv,
                KV.memories,
                mem.id,
                deletionBatch,
              );
              if (!deleted) return false;
              return true;
            }),
          );
          results.forEach((result, j) => {
            const mem = batch[j];
            if (result.status === "fulfilled" && result.value) {
              successfulIds.push(mem.id);
            } else if (result.status === "rejected") {
              logger.warn("Governance bulk delete failed", {
                memoryId: mem.id,
                error:
                  result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason),
              });
              failures.push({
                id: mem.id,
                error: "delete_failed",
              });
            }
          });
        }
      });
      await safeAudit(kv, "delete", "mem::governance-bulk", successfulIds, {
        filter: data,
        deleted: successfulIds.length,
        failed: failures.length,
        failures: failures.length > 0 ? failures : undefined,
      });

      logger.info("Governance bulk delete", {
        deleted: successfulIds.length,
        failed: failures.length,
      });
      return {
        success: failures.length === 0,
        deleted: successfulIds.length,
        failed: failures.length,
        failures: failures.length > 0 ? failures : undefined,
      };
    },
  );

  sdk.registerFunction(
    "mem::audit-query",
    async (data?: {
      operation?: AuditEntry["operation"];
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
    }) => {
      return queryAudit(kv, data);
    },
  );
}
