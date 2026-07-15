import { beforeEach, describe, expect, it } from "vitest";
import {
  mockKV,
  mockSdk,
  resetCaptureMocks,
} from "./capture-fidelity-helpers.js";

describe("capture replay provenance", () => {
  beforeEach(() => {
    resetCaptureMocks();
  });

  it("uses retained raw payloads for replay provenance", async () => {
    const { registerReplayFunctions } = await import(
      "../src/functions/replay.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:sessions", "ses_replay", {
      id: "ses_replay",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      startedAt: "2026-07-15T09:00:00.000Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_replay", "obs_replay", {
      id: "obs_replay",
      sessionId: "ses_replay",
      timestamp: "2026-07-15T10:00:00.000Z",
      type: "command_run",
      title: "Bash",
      facts: [],
      narrative: "npm test",
      concepts: [],
      files: [],
      importance: 7,
      sourceType: "post_tool_use",
      toolName: "Bash",
    });
    await kv.set("mem:raw-payloads", "obs_replay", {
      id: "obs_replay",
      sessionId: "ses_replay",
      timestamp: "2026-07-15T10:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      raw: {},
    });
    registerReplayFunctions(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::replay::load", {
      sessionId: "ses_replay",
    })) as {
      timeline: { events: Array<{ toolName?: string; toolInput?: unknown }> };
    };

    expect(result.timeline.events[0]).toMatchObject({
      toolName: "Bash",
      toolInput: { command: "npm test" },
    });
  });
});
