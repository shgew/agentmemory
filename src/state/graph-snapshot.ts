import type { GraphSnapshot } from "../types.js";
import { KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import { logger } from "../logger.js";

// #814/#825: the precomputed snapshot is the only bounded read of the
// graph. kv.list over the full graphNodes/graphEdges scopes serializes a
// multi-MB state frame that blocks the iii worker heartbeat on large
// corpora ("Invocation stopped"), so every hot path reads this single key
// instead. Maintained inline by mem::graph-extract under SNAPSHOT_KEY.
export const SNAPSHOT_KEY = "current";

export async function readGraphSnapshot(
  kv: StateKV,
): Promise<GraphSnapshot | null> {
  try {
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);
    if (snap && typeof snap === "object" && snap.version === 1) {
      return snap;
    }
    return null;
  } catch (err) {
    logger.warn("Graph snapshot read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
