import { beforeEach, describe, expect, it } from "vitest";
import { registerVerifyFunction } from "../src/functions/verify.js";
import { KV } from "../src/state/schema.js";
import type { Lesson } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const OBSOLETE_ID = "lsn_559d51303e2a617f";
const CORRECTION_ID = "lsn_e5f50d81e47afdc2";

function makeLesson(id: string, content: string): Lesson {
  const now = "2026-06-27T11:01:38.358Z";
  return {
    id,
    content,
    context: "",
    confidence: 0.7,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    project: "agentmemory",
    tags: [],
    createdAt: now,
    updatedAt: now,
    decayRate: 0.05,
  };
}

describe("Historical lesson correction backfill", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerVerifyFunction(sdk as never, kv as never);
    await kv.set(
      KV.lessons,
      OBSOLETE_ID,
      makeLesson(OBSOLETE_ID, "Set MALLOC_ARENA_MAX=2 for iii-engine."),
    );
    await kv.set(
      KV.lessons,
      CORRECTION_ID,
      makeLesson(CORRECTION_ID, "Use the verified jemalloc hardening configuration."),
    );
  });

  it("characterizes the confirmed historical pair as unlinked before backfill", async () => {
    const obsolete = (await sdk.trigger("mem::verify", {
      id: OBSOLETE_ID,
    })) as { correctionChain: unknown[]; correctedBy: unknown[] };
    const correction = (await sdk.trigger("mem::verify", {
      id: CORRECTION_ID,
    })) as { correctionChain: unknown[]; corrects: unknown[] };

    expect(obsolete.correctionChain).toEqual([]);
    expect(obsolete.correctedBy).toEqual([]);
    expect(correction.correctionChain).toEqual([]);
    expect(correction.corrects).toEqual([]);
  });
});
