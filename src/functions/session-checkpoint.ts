import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isAfter } from "../state/timestamp-compare.js";
import { recordAudit } from "./audit.js";

interface SessionCheckpointPayload {
  sessionId?: string;
}

interface SessionCheckpointResult {
  success: boolean;
  queued?: boolean;
  noOp?: boolean;
  error?: "session_not_found" | "session_not_active" | "session_has_no_activity";
  queueDepth?: number | null;
  lastCheckpointAt?: string;
}

export function registerSessionCheckpoint(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::session::checkpoint",
    async (data?: SessionCheckpointPayload): Promise<SessionCheckpointResult> => {
      const sessionId = data?.sessionId;
      if (!sessionId) {
        return { success: false, error: "session_not_found" };
      }

      return withKeyedLock(`obs:${sessionId}`, async () => {
        const session = await kv.get<Session>(KV.sessions, sessionId);
        if (!session) {
          return { success: false, error: "session_not_found" };
        }
        if (session.status !== "active") {
          return { success: false, error: "session_not_active" };
        }

        const anchor = session.updatedAt ?? session.startedAt;
        if (!anchor) {
          return { success: false, error: "session_has_no_activity" };
        }

        const watermark = session.lastCheckpointAt ?? session.endedAt;
        if (watermark !== undefined && !isAfter(anchor, watermark)) {
          return { success: true, noOp: true };
        }

        const result = await sdk.trigger({
          function_id: "event::session::checkpoint",
          payload: {
            sessionId,
            since: watermark,
            until: anchor,
            waitForCompletion: false,
          },
        });

        await kv.update<Session>(KV.sessions, sessionId, [
          { type: "set", path: "lastCheckpointAt", value: anchor },
        ]);

        await recordAudit(kv, "session_checkpoint", "mem::session::checkpoint", [sessionId], {
          since: watermark,
          until: anchor,
        });

        return {
          success: true,
          queued: true,
          queueDepth: (result as { queueDepth?: number } | undefined)?.queueDepth ?? null,
          lastCheckpointAt: anchor,
        };
      });
    },
  );
}
