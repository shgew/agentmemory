import { beforeEach, describe, expect, it } from "vitest";
import {
  getSearchAddMock,
  getVectorAddMock,
  mockKV,
  mockSdk,
  resetCaptureMocks,
} from "./capture-fidelity-helpers.js";
import type { Session } from "../src/types.js";

describe("observe capture policy routing", () => {
  beforeEach(() => {
    resetCaptureMocks();
  });

  it("stores successful discovery tools as raw-only", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:sessions", "ses_read", {
      id: "ses_read",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      startedAt: "2026-07-15T09:00:00.000Z",
      status: "active",
      observationCount: 0,
    } satisfies Session);
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_read",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "post_tool_use",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: {
        call_id: "read-1",
        tool_name: "read",
        tool_input: { filePath: "src/functions/observe.ts" },
        tool_output: "source",
      },
    })) as { observationId: string };

    expect(await kv.get("mem:raw-payloads", result.observationId)).not.toBeNull();
    expect(
      await kv.get("mem:obs:ses_read", result.observationId),
    ).toBeNull();
    expect(await kv.list("mem:pending-compression:ses_read")).toHaveLength(0);
    expect(getSearchAddMock()).not.toHaveBeenCalled();
    expect(getVectorAddMock()).not.toHaveBeenCalled();
    expect(
      sdk.triggerCalls.filter((call) => call.function_id.startsWith("stream::")),
    ).toHaveLength(2);
  });

  it("indexes commands without vectorizing them", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_command",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "post_tool_use",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: {
        call_id: "bash-1",
        tool_name: "bash",
        tool_input: { command: "npm test" },
        tool_output: "passed",
      },
    });

    expect(getSearchAddMock()).toHaveBeenCalledOnce();
    expect(getVectorAddMock()).not.toHaveBeenCalled();
  });

  it("indexes and vectorizes outcome-bearing observations", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_prompt",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "prompt_submit",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: { prompt: "fix capture performance" },
    });

    expect(getSearchAddMock()).toHaveBeenCalledOnce();
    expect(getVectorAddMock()).toHaveBeenCalledOnce();
  });
});
