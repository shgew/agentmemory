import type { StateKV } from "./kv.js";

export type IndexShardManifest = {
  readonly v: 1;
  readonly generation?: string;
  readonly shards: ReadonlyArray<{
    readonly scope: string;
    readonly key: string;
    readonly chars: number;
  }>;
  readonly chars: number;
};

export type PendingIndexGeneration = {
  readonly v: 1;
  readonly manifest: IndexShardManifest;
  readonly previous: IndexShardManifest | null;
};

export type IndexPersistenceAudit = (
  action: string,
  targetIds: string[],
  details: Record<string, unknown>,
) => Promise<void>;

type RecoverIndexGenerationInput = {
  readonly kv: StateKV;
  readonly manifestKey: string;
  readonly pendingKey: string;
  readonly scopePrefix: string;
  readonly audit: IndexPersistenceAudit;
};

export function statePath(scope: string, key: string): string {
  return `${scope}/${key}`;
}

export function isValidShardDescriptor(
  shard: unknown,
): shard is IndexShardManifest["shards"][number] {
  if (!shard || typeof shard !== "object") return false;
  const candidate = shard as { scope?: unknown; key?: unknown; chars?: unknown };
  return (
    typeof candidate.scope === "string" &&
    candidate.scope.length > 0 &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    typeof candidate.chars === "number" &&
    Number.isInteger(candidate.chars) &&
    candidate.chars >= 0
  );
}

export function manifestsEqual(
  left: IndexShardManifest | null,
  right: IndexShardManifest,
): boolean {
  if (
    left?.v !== 1 ||
    left.generation !== right.generation ||
    left.chars !== right.chars ||
    !Array.isArray(left.shards) ||
    left.shards.length !== right.shards.length
  ) {
    return false;
  }
  return left.shards.every((shard, index) => {
    const expected = right.shards[index];
    return (
      expected !== undefined &&
      shard.scope === expected.scope &&
      shard.key === expected.key &&
      shard.chars === expected.chars
    );
  });
}

export function isManagedManifest(
  manifest: IndexShardManifest | null,
  scopePrefix: string,
): manifest is IndexShardManifest & { readonly generation: string } {
  if (
    manifest?.v !== 1 ||
    typeof manifest.generation !== "string" ||
    manifest.generation.length === 0 ||
    !Array.isArray(manifest.shards) ||
    manifest.shards.length === 0 ||
    !Number.isInteger(manifest.chars) ||
    manifest.chars < 0
  ) {
    return false;
  }
  const expectedScope = new RegExp(
    `^${escapeRegExp(scopePrefix)}${escapeRegExp(manifest.generation)}:\\d{5}$`,
  );
  const ids = new Set<string>();
  let chars = 0;
  for (const shard of manifest.shards) {
    if (
      !isValidShardDescriptor(shard) ||
      shard.key !== "data" ||
      !expectedScope.test(shard.scope)
    ) {
      return false;
    }
    const id = `${shard.scope}\0${shard.key}`;
    if (ids.has(id)) return false;
    ids.add(id);
    chars += shard.chars;
  }
  return chars === manifest.chars;
}

export async function deleteIndexShards(
  kv: StateKV,
  shards: IndexShardManifest["shards"],
  current: IndexShardManifest | null,
): Promise<{ readonly deleted: number; readonly failed: number }> {
  const currentIds = new Set(
    current?.shards
      .filter(isValidShardDescriptor)
      .map((shard) => `${shard.scope}\0${shard.key}`) ?? [],
  );
  const deletable = shards.filter(
    (shard) => !currentIds.has(`${shard.scope}\0${shard.key}`),
  );
  const results = await Promise.allSettled(
    deletable.map((shard) => kv.delete(shard.scope, shard.key)),
  );
  const failed = results.filter((result) => result.status === "rejected").length;
  return { deleted: deletable.length - failed, failed };
}

export async function recoverPendingIndexGeneration(
  input: RecoverIndexGenerationInput,
): Promise<void> {
  const pending = await input.kv.get<PendingIndexGeneration>(
    "mem:index:bm25",
    input.pendingKey,
  );
  if (pending == null) return;
  if (
    pending.v !== 1 ||
    !isManagedManifest(pending.manifest, input.scopePrefix)
  ) {
    await input.kv.delete("mem:index:bm25", input.pendingKey);
    return;
  }
  const current =
    (await input.kv.get<IndexShardManifest>(
      "mem:index:bm25",
      input.manifestKey,
    )) ?? null;
  const cleanupTarget = manifestsEqual(current, pending.manifest)
    ? pending.previous
    : pending.manifest;
  if (cleanupTarget !== null) {
    if (!isManagedManifest(cleanupTarget, input.scopePrefix)) return;
    const cleanup = await deleteIndexShards(input.kv, cleanupTarget.shards, current);
    await input.audit("delete", [statePath("mem:index:bm25", input.manifestKey)], {
      manifestKey: input.manifestKey,
      generation: cleanupTarget.generation,
      reason: manifestsEqual(current, pending.manifest)
        ? "pending_previous_generation_cleanup"
        : "pending_unpublished_generation_cleanup",
      shards: cleanupTarget.shards.length,
      deleted: cleanup.deleted,
      failed: cleanup.failed,
    });
    if (cleanup.failed > 0) return;
  }
  await input.kv.delete("mem:index:bm25", input.pendingKey);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
