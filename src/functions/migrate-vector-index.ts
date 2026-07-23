import type { EmbeddingProvider, CompressedObservation, Memory } from "../types.js";
import { VectorIndex } from "../state/vector-index.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { shouldVectorizeObservation } from "./capture-policy.js";
import { logger } from "../logger.js";
import {
  clipEmbedInput,
  getRebuildEmbedBatchSize,
} from "../state/embedding-input.js";

export interface MigrateVectorIndexResult {
  success: boolean;
  totalProcessed: number;
  failed: number;
  vectorSize: number;
  failedSessions: string[];
  index: VectorIndex;
}

// Validate one embedding's shape against the provider's declared dimensions
// before pushing it into the index. Mirrors the symmetric guard in
// search.ts::vectorIndexAddGuarded — without this, a misconfigured
// provider returning the wrong-length Float32Array would silently corrupt
// the rebuilt index (per #248).
function isValidEmbedding(
  embedding: Float32Array | undefined,
  provider: EmbeddingProvider,
  context: { kind: "memory" | "observation"; id: string },
): boolean {
  if (!embedding || embedding.length !== provider.dimensions) {
    logger.warn("migrateVectorIndex: dimension mismatch — skipping", {
      kind: context.kind,
      id: context.id,
      provider: provider.name,
      expected: provider.dimensions,
      received: embedding?.length ?? null,
    });
    return false;
  }
  return true;
}

type MigrationJob = {
  id: string;
  sessionId: string;
  text: string;
  kind: "memory" | "observation";
};

async function embedJobs(
  jobs: MigrationJob[],
  provider: EmbeddingProvider,
  index: VectorIndex,
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  const batchSize = getRebuildEmbedBatchSize();
  for (let offset = 0; offset < jobs.length; offset += batchSize) {
    const batch = jobs.slice(offset, offset + batchSize);
    let embeddings: Float32Array[];
    try {
      embeddings = await provider.embedBatch(
        batch.map((job) => clipEmbedInput(job.text)),
      );
    } catch (err) {
      logger.warn("migrateVectorIndex: embedding batch failed", {
        batchSize: batch.length,
        provider: provider.name,
        error: err instanceof Error ? err.message : String(err),
      });
      failed += batch.length;
      continue;
    }
    if (embeddings.length !== batch.length) {
      logger.warn("migrateVectorIndex: provider returned wrong batch length", {
        batchSize: batch.length,
        returned: embeddings.length,
        provider: provider.name,
      });
      failed += batch.length;
      continue;
    }
    for (let indexInBatch = 0; indexInBatch < batch.length; indexInBatch++) {
      const job = batch[indexInBatch];
      const embedding = embeddings[indexInBatch];
      if (!isValidEmbedding(embedding, provider, {
        kind: job.kind,
        id: job.id,
      })) {
        failed++;
        continue;
      }
      index.add(job.id, job.sessionId, embedding);
      processed++;
    }
  }
  return { processed, failed };
}

// Rebuilds a fresh VectorIndex against `newProvider`, re-embedding every
// memory and per-session observation in `kv`. Each phase (memories +
// per-session observations) is isolated — a single session that throws
// on kv.list or embedBatch increments `failed` and appends to
// `failedSessions`, but the migration continues. Returns a structured
// result the caller can inspect to decide whether to swap the index in.
export async function migrateVectorIndex(
  kv: StateKV,
  newProvider: EmbeddingProvider,
): Promise<MigrateVectorIndexResult> {
  const newIndex = new VectorIndex();
  let failed = 0;
  let processed = 0;
  const failedSessions: string[] = [];

  // --- Memories phase ----------------------------------------------------
  // textMems is declared outside the try so the catch can attribute the
  // batch-level failure to the correct number of missed embeddings (the
  // size of the batch we were about to embed), not a flat +1.
  try {
    const memories = await kv.list<Memory>(KV.memories);
    const textMems = memories.filter(
      (m) => m.isLatest !== false && m.title && m.content && m.content.trim() !== "",
    );
    const result = await embedJobs(
      textMems.map((memory) => ({
        id: memory.id,
        sessionId: memory.sessionIds[0] ?? "memory",
        text: `${memory.title} ${memory.content}`,
        kind: "memory",
      })),
      newProvider,
      newIndex,
    );
    processed += result.processed;
    failed += result.failed;
  } catch (err) {
    logger.warn("migrateVectorIndex: failed to re-embed memories", {
      error: err instanceof Error ? err.message : String(err),
    });
    failed++;
  }

  // --- Observations phase (per-session isolation) ------------------------
  // Without per-session try/catch, one bad session (kv.list throws,
  // embedBatch rejects, etc.) would abort every later session and silently
  // truncate the migration. Each session now has its own boundary; failures
  // increment `failed`, append the session id to failedSessions, and the
  // loop moves on.
  let sessions: Array<{ id: string }>;
  try {
    sessions = await kv.list<{ id: string }>(KV.sessions);
  } catch (err) {
    logger.warn("migrateVectorIndex: failed to list sessions", {
      error: err instanceof Error ? err.message : String(err),
    });
    failed++;
    // Distinguish a list-sessions failure (catastrophic: no sessions
    // could be enumerated) from a per-session failure (one specific id
    // threw). Without the marker the caller sees failed=N + an empty
    // failedSessions list and can't tell apart "0 sessions, all OK"
    // from "kv.list itself blew up".
    failedSessions.push("<sessions-list-failed>");
    return { success: false, totalProcessed: processed, failed, vectorSize: newIndex.size, failedSessions, index: newIndex };
  }

  for (const session of sessions) {
    try {
      const observations = await kv.list<CompressedObservation>(
        KV.observations(session.id),
      );
      const textObs = observations.filter(
        (observation) =>
          observation.title && shouldVectorizeObservation(observation.type),
      );
      const result = await embedJobs(
        textObs.map((observation) => ({
          id: observation.id,
          sessionId: observation.sessionId,
          text: `${observation.title} ${observation.narrative || ""}`,
          kind: "observation",
        })),
        newProvider,
        newIndex,
      );
      processed += result.processed;
      failed += result.failed;
      if (result.failed > 0) failedSessions.push(session.id);
    } catch (err) {
      logger.warn("migrateVectorIndex: failed to re-embed session", {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
      failedSessions.push(session.id);
    }
  }

  return {
    success: failed === 0,
    totalProcessed: processed,
    failed,
    vectorSize: newIndex.size,
    failedSessions,
    index: newIndex,
  };
}
