import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  PendingCompressionEntry,
  RawObservation,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isAutoCompressEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { getSearchIndex, vectorIndexAddGuarded } from "./search.js";
import {
  clearPendingCompression,
  markPendingCompression,
} from "./raw-observations.js";
import { withObservationOwnerLock } from "./observation-lock.js";

const PENDING_COMPRESSION_CONCURRENCY = 4;

function ensureSearchIndexed(observation: CompressedObservation): void {
  const index = getSearchIndex();
  if (!index.has(observation.id)) index.add(observation);
}

function tryEnsureSearchIndexed(observation: CompressedObservation): boolean {
  try {
    ensureSearchIndexed(observation);
    return true;
  } catch (error) {
    logger.warn("Pending observation search indexing failed", {
      sessionId: observation.sessionId,
      observationId: observation.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export interface PendingCompressionDrainResult {
  attempted: number;
  completed: number;
  remainingIds: string[];
}

export interface PendingCompressionDrainOptions {
  rawPayloads?: readonly RawObservation[];
}

async function loadPendingRawObservations(
  kv: StateKV,
  sessionId: string,
): Promise<RawObservation[]> {
  const entries = await kv.list<PendingCompressionEntry>(
    KV.pendingCompression(sessionId),
  );
  const rows = await Promise.all(
    entries.map((entry) =>
      withObservationOwnerLock(entry.id, async () => {
        const raw = await kv.get<RawObservation>(KV.rawPayloads, entry.id);
        if (
          !raw ||
          raw.sessionId !== sessionId ||
          entry.sessionId !== sessionId
        ) {
          await clearPendingCompression(kv, sessionId, entry.id);
        }
        return { entry, raw };
      }),
    ),
  );
  return rows.flatMap(({ raw }) =>
    raw && raw.sessionId === sessionId ? [raw] : [],
  );
}

async function rebuildSyntheticObservation(
  kv: StateKV,
  raw: RawObservation,
): Promise<void> {
  await withObservationOwnerLock(raw.id, async () => {
    const currentRaw = await kv.get<RawObservation>(KV.rawPayloads, raw.id);
    if (!currentRaw || currentRaw.sessionId !== raw.sessionId) {
      await clearPendingCompression(kv, raw.sessionId, raw.id);
      return;
    }
    const existing = await kv.get<CompressedObservation>(
      KV.observations(raw.sessionId),
      raw.id,
    );
    if (existing?.title) {
      ensureSearchIndexed(existing);
      return;
    }

    const synthetic = buildSyntheticCompression(currentRaw);
    await kv.set(KV.observations(raw.sessionId), raw.id, synthetic);
    ensureSearchIndexed(synthetic);
    await vectorIndexAddGuarded(
      synthetic.id,
      synthetic.sessionId,
      synthetic.title + " " + (synthetic.narrative || ""),
      { kind: "synthetic", logId: synthetic.id },
    );
  });
}

export async function drainPendingCompression(
  sdk: ISdk,
  kv: StateKV,
  sessionId: string,
  options?: PendingCompressionDrainOptions,
): Promise<PendingCompressionDrainResult> {
  return withKeyedLock(`pending-compression:${sessionId}`, async () => {
    const compressed = await kv.list<CompressedObservation>(
      KV.observations(sessionId),
    );
    const compressedIds = new Set(
      compressed
        .filter(
          (observation) =>
            Boolean(observation.title) &&
            tryEnsureSearchIndexed(observation),
        )
        .map((observation) => observation.id),
    );
    const indexedRawPayloads = await loadPendingRawObservations(kv, sessionId);
    const rawPayloads = options?.rawPayloads
      ? [
          ...new Map(
            [
              ...options.rawPayloads.filter(
                (raw) => raw.sessionId === sessionId,
              ),
              ...indexedRawPayloads,
            ].map((raw) => [raw.id, raw]),
          ).values(),
        ]
      : indexedRawPayloads;
    const completedBeforeDrain = rawPayloads.filter((raw) =>
      compressedIds.has(raw.id),
    );
    await Promise.all(
      completedBeforeDrain.map((raw) =>
        clearPendingCompression(kv, sessionId, raw.id),
      ),
    );
    const pending = rawPayloads.filter((raw) => !compressedIds.has(raw.id));

    if (pending.length === 0) {
      return { attempted: 0, completed: 0, remainingIds: [] };
    }

    await Promise.all(pending.map((raw) => markPendingCompression(kv, raw)));
    const autoCompress = isAutoCompressEnabled();

    for (
      let batchStart = 0;
      batchStart < pending.length;
      batchStart += PENDING_COMPRESSION_CONCURRENCY
    ) {
      const batch = pending.slice(
        batchStart,
        batchStart + PENDING_COMPRESSION_CONCURRENCY,
      );
      await Promise.all(
        batch.map(async (raw) => {
          try {
            if (autoCompress) {
              const result = await sdk.trigger({
                function_id: "mem::compress",
                payload: {
                  observationId: raw.id,
                  sessionId,
                  raw,
                  skipIfCompressed: true,
                  requireStoredRaw: true,
                },
              });
              if (
                !result ||
                typeof result !== "object" ||
                (result as { success?: boolean }).success !== true
              ) {
                logger.warn("Pending observation compression retry failed", {
                  sessionId,
                  observationId: raw.id,
                  error:
                    result && typeof result === "object"
                      ? ((result as { error?: unknown }).error ?? "unknown")
                      : "no_result",
                });
              }
            } else {
              await rebuildSyntheticObservation(kv, raw);
            }
          } catch (error) {
            logger.warn("Pending observation compression retry failed", {
              sessionId,
              observationId: raw.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }

    const refreshed = await kv.list<CompressedObservation>(
      KV.observations(sessionId),
    );
    const refreshedIds = new Set(
      refreshed
        .filter(
          (observation) =>
            Boolean(observation.title) &&
            tryEnsureSearchIndexed(observation),
        )
        .map((observation) => observation.id),
    );
    const currentRawIds = new Set(
      (
        await Promise.all(
          pending.map((raw) => kv.get<RawObservation>(KV.rawPayloads, raw.id)),
        )
      )
        .filter(
          (raw): raw is RawObservation =>
            raw !== null && raw.sessionId === sessionId,
        )
        .map((raw) => raw.id),
    );
    const remainingIds = pending
      .filter(
        (raw) =>
          !refreshedIds.has(raw.id) && currentRawIds.has(raw.id),
      )
      .map((raw) => raw.id);
    const remainingIdSet = new Set(remainingIds);
    const completedIds = pending
      .filter((raw) => refreshedIds.has(raw.id))
      .map((raw) => raw.id);
    await Promise.all(
      pending
        .filter((raw) => !remainingIdSet.has(raw.id))
        .map((raw) => clearPendingCompression(kv, sessionId, raw.id)),
    );

    return {
      attempted: pending.length,
      completed: completedIds.length,
      remainingIds,
    };
  });
}
