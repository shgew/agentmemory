import type { FunctionMetrics } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";

export class MetricsStore {
  private cache = new Map<string, FunctionMetrics>();
  private pendingMutation: Promise<void> = Promise.resolve();

  constructor(private kv: StateKV) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingMutation.then(operation);
    this.pendingMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async record(
    functionId: string,
    latencyMs: number,
    success: boolean,
    qualityScore?: number,
  ): Promise<void> {
    await this.enqueue(async () => {
      let m = this.cache.get(functionId);
      if (!m) {
        m = (await this.kv.get<FunctionMetrics>(KV.metrics, functionId)) ?? {
          functionId,
          totalCalls: 0,
          successCount: 0,
          failureCount: 0,
          avgLatencyMs: 0,
          avgQualityScore: 0,
          qualityScoreCount: 0,
        };
      }

      const prev = m.totalCalls;
      m.totalCalls += 1;
      m.avgLatencyMs = (m.avgLatencyMs * prev + latencyMs) / m.totalCalls;
      if (success) {
        m.successCount += 1;
      } else {
        m.failureCount += 1;
      }
      if (qualityScore !== undefined) {
        const prevQualityCalls =
          m.qualityScoreCount ?? (m.avgQualityScore === 0 ? 0 : 1);
        m.avgQualityScore =
          (m.avgQualityScore * prevQualityCalls + qualityScore) /
          (prevQualityCalls + 1);
        m.qualityScoreCount = prevQualityCalls + 1;
      }

      this.cache.set(functionId, m);
      await this.kv.set(KV.metrics, functionId, m).catch(() => {});
    });
  }

  async get(functionId: string): Promise<FunctionMetrics | null> {
    await this.pendingMutation;
    return (
      this.cache.get(functionId) ??
      (await this.kv.get<FunctionMetrics>(KV.metrics, functionId))
    );
  }

  async getAll(): Promise<FunctionMetrics[]> {
    await this.pendingMutation;
    const kvMetrics = await this.kv
      .list<FunctionMetrics>(KV.metrics)
      .catch(() => []);
    const merged = new Map<string, FunctionMetrics>();
    for (const m of kvMetrics) merged.set(m.functionId, m);
    for (const [id, m] of this.cache) merged.set(id, m);
    return Array.from(merged.values());
  }

  async clear(): Promise<number> {
    return this.enqueue(async () => {
      const existing = await this.kv.list<FunctionMetrics>(KV.metrics);
      this.cache.clear();
      await Promise.all(
        existing.map((m) => this.kv.delete(KV.metrics, m.functionId)),
      );
      return existing.length;
    });
  }
}
