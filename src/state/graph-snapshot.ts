import type { GraphSnapshot } from "../types.js";
import { KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import { logger } from "../logger.js";

// Full graph scope reads can block the iii worker heartbeat, so hot paths use
// this bounded snapshot.
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
