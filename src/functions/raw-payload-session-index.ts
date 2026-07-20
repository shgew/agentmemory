import type {
  CompressedObservation,
  PendingCompressionEntry,
  RawObservation,
  RawPayloadSessionIndexMigration,
  Session,
} from "../types.js";
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

    const sessions = await kv.list<Session>(KV.sessions);
    let indexed = 0;
    for (const session of sessions) {
      const pending = await kv.list<PendingCompressionEntry>(
        KV.pendingCompression(session.id),
      );
      const observations = await kv.list<CompressedObservation>(
        KV.observations(session.id),
      );
      const rawIds = [
        ...new Set([
          ...observations.map((observation) => observation.id),
          ...pending.map((entry) => entry.id),
        ]),
      ];
      for (
        let batchStart = 0;
        batchStart < rawIds.length;
        batchStart += INDEX_WRITE_CONCURRENCY
      ) {
        await Promise.all(
          rawIds
            .slice(batchStart, batchStart + INDEX_WRITE_CONCURRENCY)
            .map((rawId) =>
              withObservationOwnerLock(rawId, async () => {
                const raw = await kv.get<RawObservation>(KV.rawPayloads, rawId);
                if (!raw || raw.sessionId !== session.id) return;
                indexed += 1;
                if (dryRun) return;
                await kv.set(KV.rawPayloadsBySession(session.id), raw.id, {
                  id: raw.id,
                  sessionId: session.id,
                });
              }),
            ),
        );
      }
    }

    if (dryRun) {
      return {
        success: true,
        indexed,
        alreadyComplete: false,
        dryRun: true,
      };
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
