import { describe, expect, it } from "vitest";
import { evaluateHealth } from "../src/health/thresholds.js";
import type { HealthSnapshot } from "../src/types.js";

const MB = 1024 * 1024;
const DEFAULT_HEAP_LIMIT = 2000 * MB;

function snap(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    connectionState: "connected",
    workers: [],
    cpu: { userMicros: 0, systemMicros: 0, percent: 0 },
    eventLoopLagMs: 0,
    uptimeSeconds: 1,
    kvConnectivity: { status: "ok", latencyMs: 1 },
    status: "healthy",
    alerts: [],
    ...over,
    memory: {
      heapUsed: 0,
      heapTotal: 1,
      rss: 0,
      external: 0,
      heapSizeLimit: DEFAULT_HEAP_LIMIT,
      ...over.memory,
    },
  };
}

describe("evaluateHealth memory severity", () => {
  it("stays healthy when the committed heap is tight but heapUsed is tiny vs the real heap limit (issue #158 / false-positive regression)", () => {
    // The viewer screenshot: heapUsed/heapTotal = 84% (committed-heap packing
    // ratio) yet heapUsed/heap_size_limit = ~9%. Must NOT alert.
    const s = snap({
      memory: {
        heapUsed: 181 * MB,
        heapTotal: 216 * MB,
        rss: 1661 * MB,
        external: 21 * MB,
        heapSizeLimit: 2000 * MB,
      },
    });
    const { status, alerts, notes } = evaluateHealth(s);
    expect(status).toBe("healthy");
    expect(alerts.find((a) => a.startsWith("memory_warn_"))).toBeUndefined();
    expect(alerts.find((a) => a.startsWith("memory_critical_"))).toBeUndefined();
    expect(notes.find((n) => n.startsWith("memory_heap_tight_"))).toBeUndefined();
  });

  it("stays healthy for a tiny steady-state process even when RSS is well above the floor", () => {
    const s = snap({
      memory: { heapUsed: 45 * MB, heapTotal: 46 * MB, rss: 1200 * MB, external: 0 },
    });
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("healthy");
    expect(alerts.some((a) => a.startsWith("memory_"))).toBe(false);
  });

  it("goes critical when heapUsed is near the real heap limit", () => {
    const s = snap({
      memory: { heapUsed: 1960 * MB, heapTotal: 1980 * MB, rss: 1100 * MB, external: 0 },
    });
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("critical");
    expect(alerts.some((a) => a.startsWith("memory_critical_"))).toBe(true);
  });

  it("goes degraded when heapUsed is in the warn band of the real heap limit", () => {
    const s = snap({
      memory: { heapUsed: 1700 * MB, heapTotal: 1720 * MB, rss: 900 * MB, external: 0 },
    });
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("degraded");
    expect(alerts.some((a) => a.startsWith("memory_warn_"))).toBe(true);
  });

  it("alerts on a low --max-old-space-size process even when RSS is below the floor", () => {
    // heapSizeLimit 128MB, heapUsed 116MB = ~91% of the real ceiling. This is a
    // genuine pre-OOM situation that the old RSS-floor AND-gate would have hidden.
    const s = snap({
      memory: {
        heapUsed: 116 * MB,
        heapTotal: 120 * MB,
        rss: 180 * MB,
        external: 0,
        heapSizeLimit: 128 * MB,
      },
    });
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("degraded");
    expect(alerts.some((a) => a.startsWith("memory_warn_"))).toBe(true);
  });

  it("legacy fallback: no heapSizeLimit + tight committed heap + RSS below floor -> heap_tight note, no alert", () => {
    const s = snap({
      memory: { heapUsed: 85 * MB, heapTotal: 100 * MB, rss: 50 * MB, external: 0, heapSizeLimit: undefined },
    });
    const { status, alerts, notes } = evaluateHealth(s);
    expect(status).toBe("healthy");
    expect(notes.some((n) => n.startsWith("memory_heap_tight_"))).toBe(true);
    expect(alerts.some((a) => a.startsWith("memory_warn_"))).toBe(false);
    expect(alerts.some((a) => a.startsWith("memory_critical_"))).toBe(false);
  });

  it("legacy fallback: no heapSizeLimit + tight committed heap + RSS above floor preserves old alert behavior", () => {
    const s = snap({
      memory: { heapUsed: 970 * MB, heapTotal: 1000 * MB, rss: 1100 * MB, external: 0, heapSizeLimit: undefined },
    });
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("critical");
    expect(alerts.some((a) => a.startsWith("memory_critical_"))).toBe(true);
  });

  it("legacy fallback: respects caller-supplied memoryRssFloorBytes", () => {
    const s = snap({
      memory: { heapUsed: 98, heapTotal: 100, rss: 50 * MB, external: 0, heapSizeLimit: undefined },
    });
    const loose = evaluateHealth(s, { memoryRssFloorBytes: 10 * MB });
    expect(loose.status).toBe("critical");
    const strict = evaluateHealth(s, { memoryRssFloorBytes: 1024 * MB });
    expect(strict.status).toBe("healthy");
  });
});
