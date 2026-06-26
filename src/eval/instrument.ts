import type { ISdk, RemoteFunctionHandler } from "iii-sdk";
import type { MetricsStore } from "./metrics-store.js";

// mem::compress and mem::summarize record their own FunctionMetrics inside
// their handlers, attaching a computed quality score this generic wrapper
// cannot derive. They are skipped here so their call counts are not recorded
// twice. Any new function that wants a quality score should return it as
// `qualityScore` on its result and let this wrapper pick it up instead of
// self-recording.
const SELF_RECORDED_FUNCTIONS = new Set(["mem::compress", "mem::summarize"]);

function readQualityScore(result: unknown): number | undefined {
  if (result && typeof result === "object" && "qualityScore" in result) {
    const score = (result as { qualityScore?: unknown }).qualityScore;
    if (typeof score === "number" && Number.isFinite(score)) return score;
  }
  return undefined;
}

function isFailureResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "success" in result &&
    (result as { success?: unknown }).success === false
  );
}

// Wrap sdk.registerFunction so every mem:: function records latency, success,
// and (when present) a quality score into the MetricsStore without each
// handler having to instrument itself. Must run before any
// registerXxxFunction(sdk, ...) so the wrapper is in place when handlers
// register. Recording is fire-and-forget: it never adds latency to a memory
// operation and a metrics failure never changes the function's result.
export function instrumentFunctionMetrics(
  sdk: ISdk,
  metricsStore: MetricsStore,
): void {
  const register = sdk.registerFunction.bind(sdk);

  sdk.registerFunction = (functionId, handler, options) => {
    if (
      typeof handler !== "function" ||
      !functionId.startsWith("mem::") ||
      SELF_RECORDED_FUNCTIONS.has(functionId)
    ) {
      return register(functionId, handler, options);
    }

    const inner = handler;
    const instrumented: RemoteFunctionHandler = async (data) => {
      const startMs = Date.now();
      try {
        const result = await inner(data);
        const latencyMs = Date.now() - startMs;
        void metricsStore
          .record(
            functionId,
            latencyMs,
            !isFailureResult(result),
            readQualityScore(result),
          )
          .catch(() => {});
        return result;
      } catch (err) {
        const latencyMs = Date.now() - startMs;
        void metricsStore.record(functionId, latencyMs, false).catch(() => {});
        throw err;
      }
    };

    return register(functionId, instrumented, options);
  };
}
