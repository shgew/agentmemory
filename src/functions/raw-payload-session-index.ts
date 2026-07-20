import type { RawObservation, RawPayloadSessionIndexMigration } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { withObservationOwnerLock } from "./observation-lock.js";
import { recordAudit } from "./audit.js";

const COMPLETION_KEY = "completed";
const MIGRATION_LOCK = "migration:raw-payloads-by-session";
const INDEX_WRITE_CONCURRENCY = 32;

export interface RawPayloadSessionIndexBackfillResult {
  success: true;
  indexed: number;
  alreadyComplete: boolean;
  dryRun: boolean;
}

export async function backfillRawPayloadSessionIndex(
  kv: StateKV,
  dryRun: boolean,
): Promise<RawPayloadSessionIndexBackfillResult> {
  return withKeyedLock(MIGRATION_LOCK, async () => {
    const completed = await kv.get<RawPayloadSessionIndexMigration>(
      KV.rawPayloadsBySessionMigration,
      COMPLETION_KEY,
    );
    if (completed) {
      return {
        success: true,
        indexed: completed.indexed,
        alreadyComplete: true,
        dryRun,
      };
    }

    const rawPayloads = await kv.list<RawObservation>(KV.rawPayloads);
    if (dryRun) {
      return {
        success: true,
        indexed: rawPayloads.length,
        alreadyComplete: false,
        dryRun: true,
      };
    }

    let indexed = 0;
    for (
      let batchStart = 0;
      batchStart < rawPayloads.length;
      batchStart += INDEX_WRITE_CONCURRENCY
    ) {
      await Promise.all(
        rawPayloads
          .slice(batchStart, batchStart + INDEX_WRITE_CONCURRENCY)
          .map((raw) =>
            withObservationOwnerLock(raw.id, async () => {
              await kv.set(KV.rawPayloadsBySession(raw.sessionId), raw.id, {
                id: raw.id,
                sessionId: raw.sessionId,
              });
              indexed += 1;
            }),
          ),
      );
    }

    const completedAt = new Date().toISOString();
    await recordAudit(
      kv,
      "raw_payload_session_index_backfill",
      "mem::migrate",
      [],
      { indexed, completedAt },
    );
    await kv.set<RawPayloadSessionIndexMigration>(
      KV.rawPayloadsBySessionMigration,
      COMPLETION_KEY,
      { indexed, completedAt },
    );

    return { success: true, indexed, alreadyComplete: false, dryRun: false };
  });
}
