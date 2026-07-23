import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLoggerInfoMock,
  getSearchAddMock,
  mockKV,
  mockSdk,
  resetCaptureMocks,
} from "./capture-fidelity-helpers.js";

describe("capture noise filtering", () => {
  beforeEach(() => {
    resetCaptureMocks();
  });

  it.each([
    "session_status",
    "session_updated",
    "llm_params",
    "messages_transform",
    "config_loaded",
    "file_watcher",
    "reasoning",
  ])(
    "drops %s without extending session lifetime",
    async (hookType) => {
      const { registerObserveFunction } = await import(
        "../src/functions/observe.js"
      );
      const sdk = mockSdk();
      const kv = mockKV();
      const dedupMap = {
        computeHash: vi.fn(() => "hash"),
        isDuplicate: vi.fn(() => false),
        record: vi.fn(),
      };
      await kv.set("mem:sessions", "ses_noise", {
        id: "ses_noise",
        project: "agentmemory",
        cwd: "/repo/agentmemory",
        startedAt: "2026-07-15T09:00:00.000Z",
        updatedAt: "2026-07-15T09:00:00.000Z",
        status: "active",
        observationCount: 3,
      });
      registerObserveFunction(sdk as never, kv as never, dedupMap as never, 3);

      const result = (await sdk.trigger("mem::observe", {
        sessionId: "ses_noise",
        project: "agentmemory",
        cwd: "/repo/agentmemory",
        hookType,
        timestamp: "2026-07-15T10:00:00.000Z",
        data: { file: "src/functions/observe.ts", event: "change" },
      })) as Record<string, unknown>;

      expect(result).toMatchObject({
        skipped: true,
        reason: "noise_event",
        hookType,
        sessionId: "ses_noise",
      });
      expect(result.observationId).toBeUndefined();
      expect(await kv.list("mem:obs:ses_noise")).toHaveLength(0);
      expect(await kv.list("mem:raw-payloads")).toHaveLength(0);
      const session = await kv.get<{
        observationCount: number;
        updatedAt: string;
      }>("mem:sessions", "ses_noise");
      expect(session?.observationCount).toBe(3);
      expect(session?.updatedAt).toBe("2026-07-15T09:00:00.000Z");
      expect(dedupMap.computeHash).not.toHaveBeenCalled();
      expect(dedupMap.record).not.toHaveBeenCalled();
      expect(getSearchAddMock()).not.toHaveBeenCalled();
    },
  );

  it("does not log capture work for dropped reasoning", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_reasoning",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "reasoning",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: { text: "internal trace" },
    });

    expect(getLoggerInfoMock()).not.toHaveBeenCalled();
  });
});
