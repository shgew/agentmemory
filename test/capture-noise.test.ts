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
  ])(
    "drops %s after only bumping session updatedAt",
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
      expect(session?.updatedAt).not.toBe("2026-07-15T09:00:00.000Z");
      expect(dedupMap.computeHash).not.toHaveBeenCalled();
      expect(dedupMap.record).not.toHaveBeenCalled();
      expect(getSearchAddMock()).not.toHaveBeenCalled();
    },
  );

  it("logs one step_finish capture sample every 20 events", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:sessions", "ses_steps", {
      id: "ses_steps",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      startedAt: "2026-07-15T09:00:00.000Z",
      updatedAt: "2026-07-15T09:00:00.000Z",
      status: "active",
      observationCount: 0,
    });
    registerObserveFunction(sdk as never, kv as never);

    for (let index = 0; index < 20; index++) {
      await sdk.trigger("mem::observe", {
        sessionId: "ses_steps",
        project: "agentmemory",
        cwd: "/repo/agentmemory",
        hookType: "step_finish",
        timestamp: `2026-07-15T10:00:${String(index).padStart(2, "0")}.000Z`,
        data: { input_tokens: index },
      });
    }

    expect(
      getLoggerInfoMock().mock.calls.filter(
        ([message]) => message === "Step-finish capture sample",
      ),
    ).toHaveLength(1);
  });
});
