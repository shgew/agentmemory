import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import { logger } from "../logger.js";
import { safeAudit } from "../functions/audit.js";
import {
  recoverPendingIndexGeneration,
} from "./index-generation.js";
import { saveShardedIndex } from "./index-shard-writer.js";
import { loadShardedIndexData } from "./index-shard-reader.js";

const DEBOUNCE_MS = 5000;
const FAILURE_LOG_THROTTLE_MS = 60_000;
const INDEX_PERSISTENCE_FUNCTION_ID = "mem::index-persistence";
const BM25_KEY = "data";
const BM25_MANIFEST_KEY = "data:manifest";
const BM25_PENDING_KEY = "data:pending";
const BM25_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:bm25:`;
const VECTOR_KEY = "vectors";
const VECTOR_MANIFEST_KEY = "vectors:manifest";
const VECTOR_PENDING_KEY = "vectors:pending";
const VECTOR_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:vectors:`;

type IndexPersistenceOptions = {
  shardChars?: number;
  createGeneration?: () => string;
};

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFailureLogAt = 0;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private kv: StateKV,
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    private options: IndexPersistenceOptions = {},
  ) {}

  scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer);
    // setTimeout discards the returned promise, so any rejection inside
    // save() would surface as unhandledRejection and crash the process
    // under sustained iii-engine write timeouts (issue #204). Funnel
    // rejections through logFailure() instead.
    this.timer = setTimeout(() => {
      this.save().catch((err) => this.logFailure(err));
    }, DEBOUNCE_MS);
  }

  async save(): Promise<void> {
    await this.enqueueSave(false);
  }

  async saveStrict(): Promise<void> {
    await this.enqueueSave(true);
  }

  private async enqueueSave(reportFailure: boolean): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const bm25 = this.bm25.serialize();
    const vector = this.vector?.serialize();
    const queued = this.saveQueue.then(async () => {
      try {
        await this.saveBm25Index(bm25);
        if (vector !== undefined) {
          await this.saveVectorIndex(vector);
        }
      } catch (err) {
        this.logFailure(err);
        if (reportFailure) throw err;
      }
    });
    this.saveQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }

  async load(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  }> {
    await Promise.all([
      recoverPendingIndexGeneration({
        kv: this.kv,
        manifestKey: BM25_MANIFEST_KEY,
        pendingKey: BM25_PENDING_KEY,
        scopePrefix: BM25_SHARD_SCOPE_PREFIX,
        audit: this.auditIndexPersistence.bind(this),
      }),
      recoverPendingIndexGeneration({
        kv: this.kv,
        manifestKey: VECTOR_MANIFEST_KEY,
        pendingKey: VECTOR_PENDING_KEY,
        scopePrefix: VECTOR_SHARD_SCOPE_PREFIX,
        audit: this.auditIndexPersistence.bind(this),
      }),
    ]);
    let bm25: SearchIndex | null = null;
    let vector: VectorIndex | null = null;

    const bm25Data = await this.loadBm25Data();
    if (bm25Data && typeof bm25Data === "string") {
      bm25 = SearchIndex.deserialize(bm25Data);
    }

    const vecData = await this.loadVectorData();
    if (vecData && typeof vecData === "string") {
      vector = VectorIndex.deserialize(vecData);
    }

    return { bm25, vector };
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private logFailure(err: unknown): void {
    const now = Date.now();
    // Throttle: persistence failures under load arrive in bursts
    // (iii-engine queue pressure). Logging every debounce flush adds
    // noise without information.
    if (now - this.lastFailureLogAt < FAILURE_LOG_THROTTLE_MS) return;
    this.lastFailureLogAt = now;
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("index persistence: failed to save BM25/vector index", {
      code,
      message,
      hint:
        code === "TIMEOUT"
          ? "iii-engine state::set timed out; recent index updates remain in memory and will retry on the next debounce flush"
          : undefined,
    });
  }

  private async saveBm25Index(serialized: string): Promise<void> {
    await saveShardedIndex({
      kv: this.kv,
      serialized,
      manifestKey: BM25_MANIFEST_KEY,
      pendingKey: BM25_PENDING_KEY,
      legacyKey: BM25_KEY,
      scopePrefix: BM25_SHARD_SCOPE_PREFIX,
      shardChars: this.options.shardChars,
      createGeneration: this.options.createGeneration,
      audit: this.auditIndexPersistence.bind(this),
    });
  }

  private async saveVectorIndex(serialized: string): Promise<void> {
    await saveShardedIndex({
      kv: this.kv,
      serialized,
      manifestKey: VECTOR_MANIFEST_KEY,
      pendingKey: VECTOR_PENDING_KEY,
      legacyKey: VECTOR_KEY,
      scopePrefix: VECTOR_SHARD_SCOPE_PREFIX,
      shardChars: this.options.shardChars,
      createGeneration: this.options.createGeneration,
      audit: this.auditIndexPersistence.bind(this),
    });
  }

  private async auditIndexPersistence(
    action: string,
    targetIds: string[],
    details: Record<string, unknown>,
  ): Promise<void> {
    await safeAudit(
      this.kv,
      "index_persist",
      INDEX_PERSISTENCE_FUNCTION_ID,
      targetIds,
      { action, ...details },
    );
  }

  private async loadBm25Data(): Promise<string | null> {
    return loadShardedIndexData({
      kv: this.kv,
      legacyKey: BM25_KEY,
      manifestKey: BM25_MANIFEST_KEY,
      label: "BM25",
    });
  }

  private async loadVectorData(): Promise<string | null> {
    return loadShardedIndexData({
      kv: this.kv,
      legacyKey: VECTOR_KEY,
      manifestKey: VECTOR_MANIFEST_KEY,
      label: "vector",
    });
  }
}
