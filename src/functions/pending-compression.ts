import type { ISdk } from "iii-sdk";
import type { CompressedObservation, RawObservation } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

const PENDING_COMPRESSION_CONCURRENCY = 4;

export interface PendingCompressionDrainResult {
  attempted: number;
  completed: number;
  remainingIds: string[];
}

export interface PendingCompressionDrainOptions {
  rawPayloads?: readonly RawObservation[];
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
        .filter((observation) => Boolean(observation.title))
        .map((observation) => observation.id),
    );
    const rawPayloads =
      options?.rawPayloads ?? (await kv.list<RawObservation>(KV.rawPayloads));
    const pending = rawPayloads.filter(
      (raw) => raw.sessionId === sessionId && !compressedIds.has(raw.id),
    );

    if (pending.length === 0) {
      return { attempted: 0, completed: 0, remainingIds: [] };
    }

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
            const result = await sdk.trigger({
              function_id: "mem::compress",
              payload: {
                observationId: raw.id,
                sessionId,
                raw,
                skipIfCompressed: true,
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
        .filter((observation) => Boolean(observation.title))
        .map((observation) => observation.id),
    );
    const remainingIds = pending
      .filter((raw) => !refreshedIds.has(raw.id))
      .map((raw) => raw.id);

    return {
      attempted: pending.length,
      completed: pending.length - remainingIds.length,
      remainingIds,
    };
  });
}
