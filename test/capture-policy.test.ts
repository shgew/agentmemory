import { describe, expect, it } from "vitest";
import {
  classifyCaptureTier,
  shouldVectorizeObservation,
} from "../src/functions/capture-policy.js";
import type { ObservationType } from "../src/types.js";

describe("capture policy", () => {
  it.each([
    ["reasoning", undefined, "drop"],
    ["step_finish", undefined, "aggregate"],
    ["session_diff", undefined, "aggregate"],
    ["post_tool_use", "read", "raw_only"],
    ["post_tool_use", "grep", "raw_only"],
    ["post_tool_use", "webfetch", "raw_only"],
    ["post_tool_use", "apply_patch", "indexed"],
    ["post_tool_use", "bash", "indexed"],
    ["post_tool_failure", "read", "indexed"],
    ["prompt_submit", undefined, "indexed"],
  ] as const)(
    "classifies %s from %s as %s",
    (hookType, toolName, expected) => {
      expect(
        classifyCaptureTier({
          hookType,
          ...(toolName ? { toolName } : {}),
        }),
      ).toBe(expected);
    },
  );

  it("keeps image-bearing tool observations indexed", () => {
    expect(
      classifyCaptureTier({
        hookType: "post_tool_use",
        toolName: "read",
        modality: "mixed",
      }),
    ).toBe("indexed");
  });

  it.each([
    ["conversation", true],
    ["error", true],
    ["decision", true],
    ["subagent", true],
    ["task", true],
    ["command_run", false],
    ["file_edit", false],
    ["file_write", false],
    ["discovery", false],
    ["notification", false],
    ["other", false],
  ] satisfies ReadonlyArray<readonly [ObservationType, boolean]>)(
    "vectorization for %s is %s",
    (type, expected) => {
      expect(shouldVectorizeObservation(type)).toBe(expected);
    },
  );
});
