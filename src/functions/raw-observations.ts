import type { ISdk } from "iii-sdk";
import type {
  RawObservation,
  PendingCompressionEntry,
  RawPayloadSessionIndexEntry,
} from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { withObservationOwnerLock } from "./observation-lock.js";
import { classifyCaptureTier } from "./capture-policy.js";

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
    await kv.set<RawPayloadSessionIndexEntry>(
      KV.rawPayloadsBySession(raw.sessionId),
      raw.id,
      { id: raw.id, sessionId: raw.sessionId },
    );
    await kv.set(KV.rawPayloads, raw.id, raw);
  } catch (error) {
    await clearPendingCompression(kv, raw.sessionId, raw.id);
    await clearRawPayloadSessionIndex(kv, raw.sessionId, raw.id);
    throw error;
  }
}

export async function listSessionRawObservations(
  kv: StateKV,
  sessionId: string,
): Promise<RawObservation[]> {
  const entries = await kv.list<RawPayloadSessionIndexEntry>(
    KV.rawPayloadsBySession(sessionId),
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
          await clearRawPayloadSessionIndex(kv, sessionId, entry.id);
          return null;
        }
        return raw;
      }),
    ),
  );
  return rows.flatMap((raw) => (raw ? [raw] : []));
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

export async function clearRawPayloadSessionIndex(
  kv: StateKV,
  sessionId: string,
  observationId: string,
): Promise<void> {
  try {
    await kv.delete(KV.rawPayloadsBySession(sessionId), observationId);
  } catch (error) {
    logger.warn("Failed to clear raw payload session index entry", {
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
  await clearRawPayloadSessionIndex(kv, sessionId, observationId);
}

export async function deleteRawObservationWithStreams(
  sdk: ISdk,
  kv: StateKV,
  raw: RawObservation,
): Promise<void> {
  if (classifyCaptureTier(raw) === "raw_only") {
    await sdk.trigger({
      function_id: "stream::delete",
      payload: {
        stream_name: STREAM.name,
        group_id: STREAM.group(raw.sessionId),
        item_id: raw.id,
      },
    });
  }
  await deleteRawObservation(kv, raw.sessionId, raw.id);
}
