import { generateId, KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import {
  deleteIndexShards,
  manifestsEqual,
  recoverPendingIndexGeneration,
  statePath,
  type IndexPersistenceAudit,
  type IndexShardManifest,
  type PendingIndexGeneration,
} from "./index-generation.js";

const DEFAULT_INDEX_SHARD_CHARS = 2_000_000;
const INDEX_SHARD_KEY = "data";

export type SaveShardedIndexInput = {
  readonly kv: StateKV;
  readonly serialized: string;
  readonly manifestKey: string;
  readonly pendingKey: string;
  readonly legacyKey: string;
  readonly scopePrefix: string;
  readonly shardChars?: number;
  readonly createGeneration?: () => string;
  readonly audit: IndexPersistenceAudit;
};

export async function saveShardedIndex(
  input: SaveShardedIndexInput,
): Promise<void> {
  await recoverPendingIndexGeneration(input);
  const previous = await input.kv
    .get<IndexShardManifest>(KV.bm25Index, input.manifestKey)
    .catch(() => null);
  const generation = input.createGeneration?.() ?? generateId("idx");
  const chunkChars = resolveShardChars(input.shardChars);
  const chunks: string[] = [];
  const shards: Array<{ scope: string; key: string; chars: number }> = [];
  for (let offset = 0; offset < input.serialized.length; offset += chunkChars) {
    const chunk = input.serialized.slice(offset, offset + chunkChars);
    const index = String(shards.length).padStart(5, "0");
    chunks.push(chunk);
    shards.push({
      scope: `${input.scopePrefix}${generation}:${index}`,
      key: INDEX_SHARD_KEY,
      chars: chunk.length,
    });
  }
  const manifest: IndexShardManifest = {
    v: 1,
    generation,
    shards,
    chars: input.serialized.length,
  };
  const pending: PendingIndexGeneration = {
    v: 1,
    manifest,
    previous,
  };
  await input.kv.set(KV.bm25Index, input.pendingKey, pending);

  const writes = await Promise.allSettled(
    shards.map((shard, index) =>
      input.kv.set(shard.scope, shard.key, chunks[index] ?? ""),
    ),
  );
  const failedWrite = writes.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failedWrite) {
    await rollbackPendingGeneration(input, manifest, previous, "shard_write_rollback");
    throw failedWrite.reason;
  }
  await input.audit("shard_write", [statePath(KV.bm25Index, input.manifestKey)], {
    manifestKey: input.manifestKey,
    generation,
    chars: input.serialized.length,
    shards: shards.length,
  });

  try {
    await input.kv.set(KV.bm25Index, input.manifestKey, manifest);
    await input.audit("manifest_publish", [
      statePath(KV.bm25Index, input.manifestKey),
    ], {
      manifestKey: input.manifestKey,
      generation,
      chars: input.serialized.length,
      shards: shards.length,
      result: "committed",
    });
  } catch (error) {
    const published = await input.kv.get<IndexShardManifest>(
      KV.bm25Index,
      input.manifestKey,
    );
    if (!manifestsEqual(published, manifest)) {
      await rollbackPendingGeneration(
        input,
        manifest,
        published,
        "manifest_publish_rollback",
      );
    } else {
      await input.audit("manifest_publish", [
        statePath(KV.bm25Index, input.manifestKey),
      ], {
        manifestKey: input.manifestKey,
        generation,
        chars: input.serialized.length,
        shards: shards.length,
        result: "committed_after_error",
        error: errorMessage(error),
      });
    }
    throw error;
  }

  if (previous !== null) {
    const cleanup = await deleteIndexShards(input.kv, previous.shards, manifest);
    await input.audit("delete", [statePath(KV.bm25Index, input.manifestKey)], {
      manifestKey: input.manifestKey,
      generation: previous.generation,
      reason: "previous_generation_cleanup",
      shards: previous.shards.length,
      deleted: cleanup.deleted,
      failed: cleanup.failed,
    });
    if (cleanup.failed === 0) {
      await input.kv.delete(KV.bm25Index, input.pendingKey);
    }
  } else {
    await input.kv.delete(KV.bm25Index, input.pendingKey);
  }
  await deleteLegacyKey(input);
}

async function rollbackPendingGeneration(
  input: SaveShardedIndexInput,
  manifest: IndexShardManifest,
  current: IndexShardManifest | null,
  reason: string,
): Promise<void> {
  const cleanup = await deleteIndexShards(input.kv, manifest.shards, current);
  await input.audit("delete", [statePath(KV.bm25Index, input.manifestKey)], {
    manifestKey: input.manifestKey,
    generation: manifest.generation,
    reason,
    shards: manifest.shards.length,
    deleted: cleanup.deleted,
    failed: cleanup.failed,
  });
  if (cleanup.failed === 0) {
    await input.kv.delete(KV.bm25Index, input.pendingKey);
  }
}

async function deleteLegacyKey(input: SaveShardedIndexInput): Promise<void> {
  let result = "deleted";
  let error: string | undefined;
  try {
    await input.kv.delete(KV.bm25Index, input.legacyKey);
  } catch (caught) {
    result = "failed";
    error = errorMessage(caught);
  }
  await input.audit("delete", [statePath(KV.bm25Index, input.legacyKey)], {
    scope: KV.bm25Index,
    key: input.legacyKey,
    reason: "legacy_cleanup",
    result,
    error,
  });
}

function resolveShardChars(configured: number | undefined): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_INDEX_SHARD_CHARS;
  }
  const wholeChars = Math.floor(configured);
  return wholeChars >= 1 ? wholeChars : DEFAULT_INDEX_SHARD_CHARS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
