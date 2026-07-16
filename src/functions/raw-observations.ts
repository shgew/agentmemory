import type { RawObservation, PendingCompressionEntry } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { withObservationOwnerLock } from "./observation-lock.js";

export async function storeRawObservation(
  kv: StateKV,
  raw: RawObservation,
): Promise<void> {
  await withObservationOwnerLock(raw.id, () =>
    storeRawObservationUnderOwnerLock(kv, raw),
  );
}

export async function storeRawObservationUnderOwnerLock(
  kv: StateKV,
  raw: RawObservation,
): Promise<void> {
  await markPendingCompression(kv, raw);
  try {
    await kv.set(KV.rawPayloads, raw.id, raw);
  } catch (error) {
    await clearPendingCompression(kv, raw.sessionId, raw.id);
    throw error;
  }
}

export async function markPendingCompression(
  kv: StateKV,
  raw: Pick<RawObservation, "id" | "sessionId">,
): Promise<void> {
  const entry: PendingCompressionEntry = {
    id: raw.id,
    sessionId: raw.sessionId,
  };
  await kv.set(KV.pendingCompression(raw.sessionId), raw.id, entry);
}

export async function clearPendingCompression(
  kv: StateKV,
  sessionId: string,
  observationId: string,
): Promise<void> {
  try {
    await kv.delete(KV.pendingCompression(sessionId), observationId);
  } catch (error) {
    logger.warn("Failed to clear pending compression entry", {
      sessionId,
      observationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function deleteRawObservation(
  kv: StateKV,
  sessionId: string,
  observationId: string,
): Promise<void> {
  await kv.delete(KV.pendingCompression(sessionId), observationId);
  await kv.delete(KV.rawPayloads, observationId);
}
