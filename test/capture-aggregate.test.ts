import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSearchAddMock,
  mockKV,
  mockSdk,
  resetCaptureMocks,
} from "./capture-fidelity-helpers.js";
import type { Session } from "../src/types.js";

describe("capture session aggregates", () => {
  beforeEach(() => {
    resetCaptureMocks();
  });

  it("aggregates step totals without creating observations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T11:00:00.000Z"));
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
      observationCount: 4,
    } satisfies Session);
    registerObserveFunction(sdk as never, kv as never);

    for (const [index, cost] of [0.25, 0.75].entries()) {
      await sdk.trigger("mem::observe", {
        sessionId: "ses_steps",
        project: "agentmemory",
        cwd: "/repo/agentmemory",
        hookType: "step_finish",
        timestamp: `2026-07-15T10:00:0${index}.000Z`,
        data: {
          partID: `step-${index}`,
          cost,
          input_tokens: 10 + index,
          output_tokens: 20 + index,
          reasoning_tokens: 30 + index,
        },
      });
    }

    const session = await kv.get<Session>("mem:sessions", "ses_steps");
    expect(session?.stepTotals).toEqual({
      count: 2,
      cost: 1,
      inputTokens: 21,
      outputTokens: 41,
      reasoningTokens: 61,
      lastAt: "2026-07-15T10:00:01.000Z",
    });
    expect(session?.observationCount).toBe(4);
    expect(session?.updatedAt).toBe("2026-07-15T11:00:00.000Z");
    expect(await kv.list("mem:obs:ses_steps")).toHaveLength(0);
    expect(await kv.list("mem:raw-payloads")).toHaveLength(0);
    expect(getSearchAddMock()).not.toHaveBeenCalled();
    expect(sdk.triggerCalls).toHaveLength(2);
    vi.useRealTimers();
  });

  it("replaces the capped session diff snapshot", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:sessions", "ses_diff", {
      id: "ses_diff",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      startedAt: "2026-07-15T09:00:00.000Z",
      status: "active",
      observationCount: 2,
    } satisfies Session);
    registerObserveFunction(sdk as never, kv as never);
    const files = Array.from({ length: 205 }, (_, index) => `src/${index}.ts`);
    const payload = {
      sessionId: "ses_diff",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "session_diff",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: { files, additions: 7, deletions: 3 },
    };

    await sdk.trigger("mem::observe", payload);
    await sdk.trigger("mem::observe", {
      ...payload,
      timestamp: "2026-07-15T10:01:00.000Z",
      data: {
        files: ["src/204.ts", "src/new.ts"],
        additions: 2,
        deletions: 1,
      },
    });

    const session = await kv.get<Session>("mem:sessions", "ses_diff");
    expect(session?.diffTotals).toMatchObject({
      events: 2,
      additions: 2,
      deletions: 1,
      lastAt: "2026-07-15T10:01:00.000Z",
    });
    expect(session?.diffTotals?.files).toEqual(["src/204.ts", "src/new.ts"]);
    expect(session?.observationCount).toBe(2);
    expect(await kv.list("mem:obs:ses_diff")).toHaveLength(0);
    expect(await kv.list("mem:raw-payloads")).toHaveLength(0);
  });

  it("deduplicates concurrent aggregate deliveries", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const hashes = new Set<string>();
    const dedupMap = {
      computeHash: vi.fn(
        (_sessionId: string, _hookType: string, identity: unknown) =>
          JSON.stringify(identity),
      ),
      isDuplicate: vi.fn((hash: string) => hashes.has(hash)),
      record: vi.fn((hash: string) => hashes.add(hash)),
    };
    await kv.set("mem:sessions", "ses_dedup", {
      id: "ses_dedup",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      startedAt: "2026-07-15T09:00:00.000Z",
      status: "active",
      observationCount: 0,
    } satisfies Session);
    registerObserveFunction(sdk as never, kv as never, dedupMap as never);
    const payload = {
      sessionId: "ses_dedup",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "step_finish",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: { partID: "same-step", input_tokens: 10 },
    };

    const results = await Promise.all([
      sdk.trigger("mem::observe", payload),
      sdk.trigger("mem::observe", payload),
    ]);

    expect(results).toContainEqual({
      deduplicated: true,
      sessionId: "ses_dedup",
    });
    expect(
      (await kv.get<Session>("mem:sessions", "ses_dedup"))?.stepTotals
        ?.count,
    ).toBe(1);
  });

  it("bounds aggregate values and sanitizes file paths", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:sessions", "ses_bounds", {
      id: "ses_bounds",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      startedAt: "2026-07-15T09:00:00.000Z",
      status: "active",
      observationCount: 0,
      stepTotals: {
        count: Number.MAX_SAFE_INTEGER,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        lastAt: "2026-07-15T09:00:00.000Z",
      },
      diffTotals: {
        events: Number.MAX_SAFE_INTEGER,
        additions: 0,
        deletions: 0,
        files: [],
        lastAt: "2026-07-15T09:00:00.000Z",
      },
    } satisfies Session);
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_bounds",
      project: 42,
      cwd: null,
      hookType: "step_finish",
      timestamp: "2026-07-15T10:00:00.000Z",
      data: {
        cost: -1,
        input_tokens: Number.POSITIVE_INFINITY,
        output_tokens: Number.MAX_VALUE,
        reasoning_tokens: -20,
      },
    });
    await sdk.trigger("mem::observe", {
      sessionId: "ses_bounds",
      project: 42,
      cwd: null,
      hookType: "session_diff",
      timestamp: "2026-07-15T10:01:00.000Z",
      data: {
        files: [
          `src/${"x".repeat(2000)}.ts`,
          "token=abcdefghijklmnopqrstuvwxyz1234567890",
        ],
        additions: -3,
        deletions: Number.POSITIVE_INFINITY,
      },
    });

    const session = await kv.get<Session>("mem:sessions", "ses_bounds");
    expect(session?.stepTotals).toMatchObject({
      count: Number.MAX_SAFE_INTEGER,
      cost: 0,
      inputTokens: 0,
      outputTokens: Number.MAX_SAFE_INTEGER,
      reasoningTokens: 0,
    });
    expect(session?.diffTotals).toMatchObject({
      events: Number.MAX_SAFE_INTEGER,
      additions: 0,
      deletions: 0,
    });
    expect(session?.diffTotals?.files[0].length).toBeLessThanOrEqual(1024);
    expect(session?.diffTotals?.files[1]).toContain("[REDACTED_SECRET]");
  });
});
