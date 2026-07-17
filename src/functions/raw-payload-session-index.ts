import type { RawObservation, RawPayloadSessionIndexMigration } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { withObservationOwnerLock } from "./observation-lock.js";
import { recordAudit } from "./audit.js";

const COMPLETION_KEY = "completed";
const MIGRATION_LOCK = "migration:raw-payloads-by-session";

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
    let indexed = 0;
    for (const raw of rawPayloads) {
      await withObservationOwnerLock(raw.id, async () => {
        const current = await kv.get<RawObservation>(KV.rawPayloads, raw.id);
        if (!current || current.sessionId !== raw.sessionId) return;
        indexed += 1;
        if (dryRun) return;
        await kv.set(KV.rawPayloadsBySession(current.sessionId), current.id, {
          id: current.id,
          sessionId: current.sessionId,
        });
      });
    }

    if (!dryRun) {
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
    }

    return { success: true, indexed, alreadyComplete: false, dryRun };
  });
}
