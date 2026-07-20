import { logger } from "../logger.js";
import type { StateKV } from "./kv.js";
import {
  isValidShardDescriptor,
  type IndexShardManifest,
} from "./index-generation.js";
import { KV } from "./schema.js";

type ReadIndexValueResult<T> =
  | { readonly ok: true; readonly value: T | null }
  | { readonly ok: false };

type LoadShardedIndexInput = {
  readonly kv: StateKV;
  readonly legacyKey: string;
  readonly manifestKey: string;
  readonly label: string;
};

export async function loadShardedIndexData(
  input: LoadShardedIndexInput,
): Promise<string | null> {
  const manifest = await readIndexValue<IndexShardManifest>(
    input.kv,
    input.manifestKey,
    input.label,
    "manifest",
  );
  if (!manifest.ok) return null;
  if (manifest.value != null && typeof manifest.value === "object") {
    return loadManifestData(input.kv, manifest.value, input.label);
  }
  const legacy = await readIndexValue<string>(
    input.kv,
    input.legacyKey,
    input.label,
    "legacy",
  );
  if (!legacy.ok) return null;
  return typeof legacy.value === "string" && legacy.value.length > 0
    ? legacy.value
    : null;
}

async function readIndexValue<T>(
  kv: StateKV,
  key: string,
  label: string,
  source: "manifest" | "legacy",
): Promise<ReadIndexValueResult<T>> {
  try {
    return { ok: true, value: await kv.get<T>(KV.bm25Index, key) };
  } catch (error) {
    logger.warn(`index persistence: ${label} ${source} read failed`, {
      scope: KV.bm25Index,
      key,
      message: errorMessage(error),
    });
    return { ok: false };
  }
}

async function loadManifestData(
  kv: StateKV,
  manifest: IndexShardManifest,
  label: string,
): Promise<string | null> {
  if (
    manifest.v !== 1 ||
    !Array.isArray(manifest.shards) ||
    manifest.shards.length === 0 ||
    !Number.isInteger(manifest.chars) ||
    manifest.chars < 0 ||
    manifest.shards.some((shard) => !isValidShardDescriptor(shard))
  ) {
    logger.warn(`index persistence: ${label} shard manifest invalid`);
    return null;
  }
  const loadedShards = await Promise.all(
    manifest.shards.map(async (shard) => ({
      shard,
      chunk: await kv.get<string>(shard.scope, shard.key).catch(() => null),
    })),
  );
  const chunks: string[] = [];
  let chars = 0;
  for (const { shard, chunk } of loadedShards) {
    if (typeof chunk !== "string") {
      logger.warn(`index persistence: ${label} shard missing`, {
        scope: shard.scope,
        key: shard.key,
      });
      return null;
    }
    if (chunk.length !== shard.chars) {
      logger.warn(`index persistence: ${label} shard length mismatch`, {
        scope: shard.scope,
        key: shard.key,
        expected: shard.chars,
        actual: chunk.length,
      });
      return null;
    }
    chunks.push(chunk);
    chars += chunk.length;
  }
  if (chars !== manifest.chars) {
    logger.warn(`index persistence: ${label} total length mismatch`, {
      expected: manifest.chars,
      actual: chars,
    });
    return null;
  }
  return chunks.join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
