import type { ObservationType, RawObservation } from "../types.js";
import { inferObservationType } from "./compress-synthetic.js";

const CAPTURE_TIERS = {
  DROP: "drop",
  AGGREGATE: "aggregate",
  RAW_ONLY: "raw_only",
  INDEXED: "indexed",
} as const;

export type CaptureTier =
  (typeof CAPTURE_TIERS)[keyof typeof CAPTURE_TIERS];

type CaptureTierInput = Pick<
  RawObservation,
  "hookType" | "toolName" | "modality"
>;

const RAW_ONLY_TYPES = new Set<ObservationType>([
  "file_read",
  "search",
  "web_fetch",
]);

const VECTOR_TYPES = new Set<ObservationType>([
  "conversation",
  "error",
  "decision",
  "subagent",
  "task",
]);

export function classifyCaptureTier(input: CaptureTierInput): CaptureTier {
  if (input.hookType === "reasoning") return CAPTURE_TIERS.DROP;
  if (
    input.hookType === "step_finish" ||
    input.hookType === "session_diff"
  ) {
    return CAPTURE_TIERS.AGGREGATE;
  }
  if (
    input.hookType === "post_tool_use" &&
    input.modality === undefined &&
    RAW_ONLY_TYPES.has(inferObservationType(input))
  ) {
    return CAPTURE_TIERS.RAW_ONLY;
  }
  return CAPTURE_TIERS.INDEXED;
}

export function shouldVectorizeObservation(type: ObservationType): boolean {
  return VECTOR_TYPES.has(type);
}
