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
  deleteRawObservation,
  deleteRawObservationWithStreams,
  markPendingCompression,
} from "./raw-observations.js";
import { withObservationOwnerLock } from "./observation-lock.js";
import {
  classifyCaptureTier,
  shouldVectorizeObservation,
} from "./capture-policy.js";

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
  rawPayloadRetentionCutoff?: string;
}

export async function retireExpiredRawOnlyObservations(
  sdk: ISdk,
  kv: StateKV,
  rawPayloads: readonly RawObservation[],
  retentionCutoff: string,
): Promise<string[]> {
  const failedIds: string[] = [];
  await Promise.all(
    rawPayloads
      .filter(
        (raw) =>
          classifyCaptureTier(raw) === "raw_only" &&
          raw.timestamp <= retentionCutoff,
      )
      .map(async (raw) => {
        try {
          await deleteRawObservationWithStreams(sdk, kv, raw);
        } catch (error) {
          failedIds.push(raw.id);
          logger.warn("Raw-only stream retirement failed", {
            sessionId: raw.sessionId,
            observationId: raw.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
  );
  return failedIds;
}

async function loadPendingRawObservations(
  kv: StateKV,
  sessionId: string,
): Promise<Map<string, RawObservation>> {
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
  return new Map(
    rows.flatMap(({ entry, raw }): [string, RawObservation][] =>
      raw && raw.sessionId === sessionId ? [[entry.id, raw]] : [],
    ),
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
    if (shouldVectorizeObservation(synthetic.type)) {
      await vectorIndexAddGuarded(
        synthetic.id,
        synthetic.sessionId,
        synthetic.title + " " + (synthetic.narrative || ""),
        { kind: "synthetic", logId: synthetic.id },
      );
    }
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
    const pendingRawPayloads = await loadPendingRawObservations(kv, sessionId);
    const indexedRawPayloads = [...pendingRawPayloads.values()];
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
    const rawOnlyIds = new Set(
      rawPayloads
        .filter((raw) => classifyCaptureTier(raw) === "raw_only")
        .map((raw) => raw.id),
    );
    const completedBeforeDrain = rawPayloads.filter(
      (raw) =>
        pendingRawPayloads.has(raw.id) &&
        (compressedIds.has(raw.id) || rawOnlyIds.has(raw.id)),
    );
    const rawPayloadRetentionCutoff = options?.rawPayloadRetentionCutoff;
    const expiredRawIds = new Set(
      rawPayloadRetentionCutoff
        ? rawPayloads
            .filter(
              (raw) =>
                (compressedIds.has(raw.id) || rawOnlyIds.has(raw.id)) &&
                raw.timestamp <= rawPayloadRetentionCutoff,
            )
            .map((raw) => raw.id)
        : [],
    );
    const failedRetirements = new Set(
      rawPayloadRetentionCutoff
        ? await retireExpiredRawOnlyObservations(
            sdk,
            kv,
            rawPayloads,
            rawPayloadRetentionCutoff,
          )
        : [],
    );
    const completedBeforeDrainIds = new Set(completedBeforeDrain.map((raw) => raw.id));
    for (const failedId of failedRetirements) {
      completedBeforeDrainIds.delete(failedId);
    }
    await Promise.all(
      rawPayloads
        .filter(
          (raw) =>
            (compressedIds.has(raw.id) || rawOnlyIds.has(raw.id)) &&
            !(rawOnlyIds.has(raw.id) && expiredRawIds.has(raw.id)),
        )
        .map(async (raw) => {
          if (expiredRawIds.has(raw.id)) {
            await deleteRawObservation(kv, sessionId, raw.id);
            return;
          }
          if (pendingRawPayloads.has(raw.id)) {
            await clearPendingCompression(kv, sessionId, raw.id);
          }
        }),
    );
    const pending = rawPayloads.filter(
      (raw) => !compressedIds.has(raw.id) && !rawOnlyIds.has(raw.id),
    );

    if (pending.length === 0) {
      return {
        attempted: 0,
        completed: completedBeforeDrainIds.size,
        remainingIds: [...failedRetirements],
      };
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
        .map((raw) =>
          expiredRawIds.has(raw.id)
            ? deleteRawObservation(kv, sessionId, raw.id)
            : clearPendingCompression(kv, sessionId, raw.id),
        ),
    );

    return {
      attempted: pending.length,
      completed: completedBeforeDrainIds.size + completedIds.length,
      remainingIds: [...failedRetirements, ...remainingIds],
    };
  });
}
