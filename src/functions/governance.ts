import type { ISdk } from "iii-sdk";
import type {
  Memory,
  GovernanceFilter,
  AuditEntry,
  CompressedObservation,
  RawObservation,
  Session,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAudit, safeAudit, queryAudit } from "./audit.js";
import { deleteAccessLog } from "./access-tracker.js";
import { getSearchIndex, vectorIndexRemove, flushIndexSave } from "./search.js";
import { logger } from "../logger.js";

async function locateObservationSession(
  kv: StateKV,
  id: string,
  raw: RawObservation | null,
): Promise<string | null> {
  if (raw) return raw.sessionId;

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

async function decrementImageRefs(
  sdk: ISdk,
  kv: StateKV,
  ...refs: Array<string | undefined>
): Promise<void> {
  const imageRefs = Array.from(
    new Set(
      refs.filter(
        (ref): ref is string => typeof ref === "string" && ref.length > 0,
      ),
    ),
  );
  if (imageRefs.length === 0) return;

  const { decrementImageRef } = await import("./image-refs.js");
  for (const imageRef of imageRefs) {
    await decrementImageRef(kv, sdk, imageRef);
  }
}

async function decrementObservationCount(
  kv: StateKV,
  sessionId: string,
): Promise<void> {
  const session = await kv.get<Session>(KV.sessions, sessionId);
  if (!session) return;

  const currentCount =
    typeof session.observationCount === "number" &&
    Number.isFinite(session.observationCount)
      ? Math.max(0, Math.floor(session.observationCount))
      : 0;
  const observationCount = Math.max(0, currentCount - 1);
  if (session.observationCount === observationCount) return;

  await kv.update<Session>(KV.sessions, sessionId, [
    { type: "set", path: "observationCount", value: observationCount },
  ]);
}

async function deleteObservation(
  sdk: ISdk,
  kv: StateKV,
  id: string,
  raw: RawObservation | null,
): Promise<boolean> {
  const sessionId = await locateObservationSession(kv, id, raw);
  if (!sessionId) return false;

  return withKeyedLock(`obs:${sessionId}`, async () => {
    const [currentObservation, currentRaw] = await Promise.all([
      kv.get<CompressedObservation>(KV.observations(sessionId), id),
      kv.get<RawObservation>(KV.rawPayloads, id),
    ]);
    if (!currentObservation && !currentRaw) return false;

    await decrementImageRefs(
      sdk,
      kv,
      currentObservation?.imageData,
      currentObservation?.imageRef,
      currentRaw?.imageData,
    );

    if (currentObservation) {
      await kv.delete(KV.observations(sessionId), id);
    }
    if (currentRaw) await kv.delete(KV.rawPayloads, id);
    await deleteAccessLog(kv, id);
    await decrementObservationCount(kv, sessionId);
    return true;
  });
}

export function registerGovernanceFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::governance-delete", 
    async (data: { memoryIds: string[]; reason?: string }) => {
      if (
        !data.memoryIds ||
        !Array.isArray(data.memoryIds) ||
        data.memoryIds.length === 0
      ) {
        return { success: false, error: "memoryIds array is required" };
      }

      let deleted = 0;
      for (const id of data.memoryIds) {
        const mem = await kv.get<Memory>(KV.memories, id);
        if (mem) {
          await decrementImageRefs(sdk, kv, mem.imageData, mem.imageRef);
          await kv.delete(KV.memories, id);
          await deleteAccessLog(kv, id);
          getSearchIndex().remove(id);
          vectorIndexRemove(id);
          deleted++;
          continue;
        }

        const raw = await kv.get<RawObservation>(KV.rawPayloads, id);
        if (await deleteObservation(sdk, kv, id, raw)) {
          getSearchIndex().remove(id);
          vectorIndexRemove(id);
          deleted++;
        }
      }

      if (deleted > 0) await flushIndexSave();

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

  sdk.registerFunction("mem::governance-bulk", 
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
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (mem) => {
            await kv.delete(KV.memories, mem.id);
            await deleteAccessLog(kv, mem.id);
            getSearchIndex().remove(mem.id);
            vectorIndexRemove(mem.id);
          }),
        );
        results.forEach((result, j) => {
          const mem = batch[j];
          if (result.status === "fulfilled") {
            successfulIds.push(mem.id);
          } else {
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

      if (successfulIds.length > 0) await flushIndexSave();

      await safeAudit(
        kv,
        "delete",
        "mem::governance-bulk",
        successfulIds,
        {
          filter: data,
          deleted: successfulIds.length,
          failed: failures.length,
          failures: failures.length > 0 ? failures : undefined,
        },
      );

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

  sdk.registerFunction("mem::audit-query", 
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
