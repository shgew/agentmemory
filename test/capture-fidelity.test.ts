import { beforeEach, describe, expect, it, vi } from "vitest";
import { KV } from "../src/state/schema.js";
import type { MemoryProvider, RawObservation } from "../src/types.js";
import {
  mockKV,
  mockSdk,
  resetCaptureMocks,
} from "./capture-fidelity-helpers.js";

describe("capture fidelity characterization", () => {
  beforeEach(() => {
    resetCaptureMocks();
  });

  it("stores the raw payload separately and preserves synthetic provenance", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_provenance",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "post_tool_use",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: {
        tool_name: "Edit",
        tool_input: {
          request: { file_path: "src/functions/observe.ts" },
        },
        metadata: {
          changed: ["src/functions/compress.ts"],
        },
      },
    });

    const stored = await kv.list<Record<string, unknown>>(
      "mem:obs:ses_provenance",
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].hookType).toBeUndefined();
    expect(stored[0].sourceType).toBe("post_tool_use");
    expect(stored[0].toolName).toBe("Edit");
    expect(stored[0].files).toEqual([
      "src/functions/observe.ts",
      "src/functions/compress.ts",
    ]);

    const rawPayloads = await kv.list<RawObservation>("mem:raw-payloads");
    expect(rawPayloads).toHaveLength(1);
    expect(rawPayloads[0]).toMatchObject({
      hookType: "post_tool_use",
      toolName: "Edit",
    });
  });

  it("preserves assistant text through observation and synthetic compression", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_assistant",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "assistant_message",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: { messageID: "msg_1", message: "Fixed lifecycle ownership." },
    });

    const raw = await kv.list<RawObservation>("mem:raw-payloads");
    const compressed = await kv.list<Record<string, unknown>>(
      "mem:obs:ses_assistant",
    );
    expect(raw[0].assistantResponse).toBe("Fixed lifecycle ownership.");
    expect(compressed[0].narrative).toContain("Fixed lifecycle ownership.");
  });

  it("preserves subagent final text through observation and synthetic compression", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_subagent",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "subagent_stop",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: { agent_id: "worker-1", last_message: "Found the lock race." },
    });

    const raw = await kv.list<RawObservation>("mem:raw-payloads");
    const compressed = await kv.list<Record<string, unknown>>(
      "mem:obs:ses_subagent",
    );
    expect(raw[0].assistantResponse).toBe("Found the lock race.");
    expect(compressed[0].narrative).toContain("Found the lock race.");
  });

  it("includes assistant text in the LLM compression prompt", async () => {
    const { buildCompressionPrompt } = await import(
      "../src/prompts/compression.js"
    );
    const prompt = buildCompressionPrompt({
      hookType: "assistant_message",
      assistantResponse: "Final answer with the verified root cause.",
      timestamp: "2026-07-15T10:00:00.000Z",
    });

    expect(prompt).toContain(
      "Assistant response:\nFinal answer with the verified root cause.",
    );
  });

  it.each([
    ["post_tool_use", "Edit", 7],
    ["post_tool_use", "Bash", 7],
    ["task_completed", undefined, 6],
    ["prompt_submit", undefined, 6],
    ["post_tool_use", "Read", 4],
    ["post_tool_use", "Grep", 4],
    ["session_status", undefined, 2],
    ["config_loaded", undefined, 2],
  ])(
    "assigns deterministic importance for %s/%s",
    async (hookType, toolName, expectedImportance) => {
      const { buildSyntheticCompression } = await import(
        "../src/functions/compress-synthetic.js"
      );
      const raw: RawObservation = {
        id: "obs_importance",
        sessionId: "ses_importance",
        timestamp: "2026-07-15T10:00:00.000Z",
        hookType,
        toolName,
        raw: {},
      };

      expect(buildSyntheticCompression(raw).importance).toBe(
        expectedImportance,
      );
    },
  );

  it("applies event mapping, importance, files, and provenance to LLM compression", async () => {
    const { registerCompressFunction } = await import(
      "../src/functions/compress.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const provider: MemoryProvider = {
      name: "test",
      compress: async () => `<type>other</type>
<title>LLM title</title>
<facts><fact>Changed capture storage</fact></facts>
<narrative>Changed capture storage.</narrative>
<concepts><concept>capture</concept></concepts>
<files></files>
<importance>1</importance>`,
      summarize: async () => "",
    };
    registerCompressFunction(sdk as never, kv as never, provider);
    const raw: RawObservation = {
      id: "obs_llm",
      sessionId: "ses_llm",
      timestamp: "2026-07-15T10:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "Edit",
      toolInput: { nested: { path: "src/functions/compress.ts" } },
      raw: { metadata: { files: ["src/functions/observe.ts"] } },
    };

    const result = (await sdk.trigger("mem::compress", {
      observationId: raw.id,
      sessionId: raw.sessionId,
      raw,
    })) as { compressed: Record<string, unknown> };

    expect(result.compressed.type).toBe("file_edit");
    expect(result.compressed.importance).toBe(7);
    expect(result.compressed.sourceType).toBe("post_tool_use");
    expect(result.compressed.toolName).toBe("Edit");
    expect(result.compressed.files).toEqual([
      "src/functions/compress.ts",
      "src/functions/observe.ts",
    ]);
  });

  it("does not compress a retained payload after its raw owner was deleted", async () => {
    const { registerCompressFunction } = await import(
      "../src/functions/compress.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const compress = vi.fn().mockResolvedValue(`<type>conversation</type>
<title>Deleted observation</title>
<facts></facts>
<narrative>Deleted observation</narrative>
<concepts></concepts>
<files></files>
<importance>5</importance>`);
    const provider: MemoryProvider = {
      name: "test",
      compress,
      summarize: async () => "",
    };
    registerCompressFunction(sdk as never, kv as never, provider);
    const raw: RawObservation = {
      id: "obs_deleted",
      sessionId: "ses_deleted",
      timestamp: "2026-07-16T10:00:00.000Z",
      hookType: "prompt_submit",
      raw: {},
    };

    const result = await sdk.trigger("mem::compress", {
      observationId: raw.id,
      sessionId: raw.sessionId,
      raw,
      requireStoredRaw: true,
    });

    expect(result).toMatchObject({ success: true, noOp: true });
    expect(compress).not.toHaveBeenCalled();
    expect(await kv.get(KV.observations(raw.sessionId), raw.id)).toBeNull();
  });

  it("bounds recursive file extraction and tolerates cyclic input", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const cyclic: Record<string, unknown> = {
      nested: { file: "src/functions/compress-synthetic.ts" },
    };
    cyclic["self"] = cyclic;
    cyclic["tooDeep"] = {
      one: { two: { three: { four: { path: "src/ignored.ts" } } } },
    };

    const result = buildSyntheticCompression({
      id: "obs_nested",
      sessionId: "ses_nested",
      timestamp: "2026-07-15T10:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "Edit",
      toolInput: cyclic,
      raw: { payload: { files: ["src/types.ts"] } },
    });

    expect(result.files).toEqual([
      "src/functions/compress-synthetic.ts",
      "src/types.ts",
    ]);
  });

  it("returns an empty file list when no strings look like paths", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );

    const result = buildSyntheticCompression({
      id: "obs_no_files",
      sessionId: "ses_no_files",
      timestamp: "2026-07-15T10:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "Edit",
      toolInput: { nested: { value: "plain text" } },
      raw: { metadata: { label: "not a path" } },
    });

    expect(result.files).toEqual([]);
  });

  it("keeps session_diff as a session file aggregate", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_diff",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "session_diff",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: { files: ["src/functions/observe.ts"] },
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ aggregated: true, sessionId: "ses_diff" });
    expect(await kv.list("mem:obs:ses_diff")).toHaveLength(0);
    expect(await kv.get("mem:sessions", "ses_diff")).toMatchObject({
      observationCount: 0,
      diffTotals: {
        events: 1,
        additions: 0,
        deletions: 0,
        files: ["src/functions/observe.ts"],
        lastAt: "2026-07-15T10:00:00.000Z",
      },
    });
  });

});
