import { TriggerAction, type ISdk } from "iii-sdk";
import type { RawObservation, HookPayload, Session } from "../types.js";
import { KV, STREAM, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { getAgentId, getEnvVar, isAutoCompressEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { getSearchIndex, vectorIndexAddGuarded } from "./search.js";
import { isAfter } from "../state/timestamp-compare.js";
import { logger } from "../logger.js";
import {
  clearPendingCompression,
  storeRawObservation,
} from "./raw-observations.js";
import {
  withObservationSessionOwnerLock,
} from "./image-owner.js";

const postCompletionWarned = new Set<string>();
const NOISE_HOOK_TYPES = new Set([
  "session_status",
  "session_updated",
  "llm_params",
  "messages_transform",
  "config_loaded",
  "file_watcher",
]);
const STEP_FINISH_SAMPLE_EVERY = 20;
let stepFinishCaptureCount = 0;

const EVENT_IDENTITY_KEYS = [
  "event_id",
  "call_id",
  "tool_use_id",
  "subtask_id",
  "question_id",
  "request_id",
  "permission_id",
  "pty_id",
  "messageID",
  "message_id",
  "partID",
  "part_id",
  "tool_call_id",
] as const;

function eventIdentity(data: unknown): Record<string, string | number> | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const identity: Record<string, string | number> = {};
  for (const key of EVENT_IDENTITY_KEYS) {
    const value = record[key];
    if (
      (typeof value === "string" && value.length > 0) ||
      typeof value === "number"
    ) {
      identity[key] = value;
    }
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

function sessionIdentityError(
  session: Pick<Session, "project" | "agentId">,
  payload: HookPayload,
): string | null {
  const project =
    typeof payload.project === "string" ? payload.project.trim() : "";
  if (project && project !== session.project) {
    return "observation project does not match session";
  }
  const agentId = getAgentId();
  if (session.agentId && agentId && session.agentId !== agentId) {
    return "observation agent does not match session";
  }
  return null;
}

export function extractImage(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") {
    if (d.startsWith("data:image/") || d.startsWith("iVBORw0KGgo") || d.startsWith("/9j/")) {
      return d;
    }
    return undefined;
  }
  if (typeof d === "object" && d !== null) {
    const obj = d as Record<string, unknown>;
    if (typeof obj["image_data"] === "string") return obj["image_data"];
    if (typeof obj["image_path"] === "string") return obj["image_path"];
    if (typeof obj["imageBase64"] === "string") return obj["imageBase64"];
    if (typeof obj["imagePath"] === "string") return obj["imagePath"];

    for (const key of Object.keys(obj)) {
      const match = extractImage(obj[key]);
      if (match) return match;
    }
  }
  return undefined;
}

// Publish an observation to the live-viewer streams without blocking or
// failing capture. Stream writes are best-effort (the durable record already
// lives in KV); a disconnected stream worker must not throw mem::observe or add
// inter-worker round-trip latency to the hot path, so dispatch fire-and-forget
// with TriggerAction.Void() and surface any rejection as a warning only.
function publishToStreams(
  sdk: ISdk,
  obsId: string,
  sessionId: string,
  requests: Array<{ function_id: string; payload: Record<string, unknown> }>,
): void {
  void Promise.allSettled(
    requests.map((req) =>
      sdk.trigger({
        function_id: req.function_id,
        payload: req.payload,
        action: TriggerAction.Void(),
      }),
    ),
  ).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("Non-fatal stream publish failure in observe", {
          obsId,
          sessionId,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }
  });
}

export function registerObserveFunction(
  sdk: ISdk,
  kv: StateKV,
  dedupMap?: DedupMap,
  maxObservationsPerSession?: number,
): void {
  sdk.registerFunction("mem::observe", 
    async (payload: HookPayload) => {

      if (
        !payload?.sessionId ||
        typeof payload.sessionId !== "string" ||
        !payload.hookType ||
        typeof payload.hookType !== "string" ||
        !payload.timestamp ||
        typeof payload.timestamp !== "string"
      ) {
        return {
          success: false,
          error:
            "Invalid payload: sessionId, hookType, and timestamp are required",
        };
      }

      if (NOISE_HOOK_TYPES.has(payload.hookType)) {
        return withKeyedLock(`obs:${payload.sessionId}`, async () => {
          const session = await kv.get<Session>(KV.sessions, payload.sessionId);
          if (session) {
            const identityError = sessionIdentityError(session, payload);
            if (identityError) return { success: false, error: identityError };
          }
          return {
            skipped: true,
            reason: "noise_event",
            hookType: payload.hookType,
            sessionId: payload.sessionId,
          };
        });
      }

      const obsId = generateId("obs");

      let dedupHash: string | undefined;
      if (dedupMap) {
        const identity = eventIdentity(payload.data);
        if (identity) {
          dedupHash = dedupMap.computeHash(
            payload.sessionId,
            payload.hookType,
            identity,
          );
          if (dedupMap.isDuplicate(dedupHash)) {
            return { deduplicated: true, sessionId: payload.sessionId };
          }
        }
      }

      let sanitizedRaw: unknown = payload.data;
      try {
        const jsonStr = JSON.stringify(payload.data);
        const sanitized = stripPrivateData(jsonStr);
        sanitizedRaw = JSON.parse(sanitized);
      } catch {
        sanitizedRaw = stripPrivateData(String(payload.data));
      }

      const raw: RawObservation = {
        id: obsId,
        sessionId: payload.sessionId,
        timestamp: payload.timestamp,
        hookType: payload.hookType,
        raw: sanitizedRaw,
      };

      let extractedImage: string | undefined;

      if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
        const d = sanitizedRaw as Record<string, unknown>;
        if (
          payload.hookType === "post_tool_use" ||
          payload.hookType === "post_tool_failure"
        ) {
          raw.toolName = d["tool_name"] as string | undefined;
          raw.toolInput = d["tool_input"];
          raw.toolOutput = d["tool_output"] || d["error"];
        }
        if (payload.hookType === "prompt_submit") {
          raw.userPrompt = d["prompt"] as string | undefined;
        }
        if (
          payload.hookType === "assistant_message" &&
          typeof d["message"] === "string"
        ) {
          raw.assistantResponse = d["message"];
        }
        if (
          payload.hookType === "subagent_stop" &&
          typeof d["last_message"] === "string"
        ) {
          raw.assistantResponse = d["last_message"];
        }

        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = (raw.toolInput || raw.toolOutput || raw.userPrompt) ? "mixed" : "image";
        }
      } else if (typeof sanitizedRaw === "string") {
        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = "image";
        }
      }

      const pendingImageData = extractedImage;

      const captureObservation = async () => {
        // The existing session row is the source of truth for both agentId
        // (even when undefined) and the observation-count cap. Env AGENT_ID
        // only applies when no row exists yet; otherwise an unscoped session
        // would get retroactively scoped by a later AGENT_ID export.
        const existingSession = await kv.get<Session>(
          KV.sessions,
          payload.sessionId,
        );
        if (existingSession) {
          const identityError = sessionIdentityError(existingSession, payload);
          if (identityError) return { success: false, error: identityError };
        }

        // Soft lifetime cap via the maintained observationCount (O(1)) instead
        // of listing all stored observations (O(n)). Reaching the cap is an
        // intentional drop, not an error, so the return omits success:false and
        // the FunctionMetrics instrument does not score it as a failure.
        if (maxObservationsPerSession && maxObservationsPerSession > 0) {
          const currentCount = existingSession?.observationCount ?? 0;
          if (currentCount >= maxObservationsPerSession) {
            return {
              skipped: true,
              limitReached: true,
              reason: "observation_limit_reached",
              sessionId: payload.sessionId,
              limit: maxObservationsPerSession,
            };
          }
        }

        const inheritedAgentId = existingSession
          ? existingSession.agentId
          : getAgentId();
        if (inheritedAgentId) {
          raw.agentId = inheritedAgentId;
        }

        if (pendingImageData && (pendingImageData.startsWith("data:image/") || pendingImageData.startsWith("iVBORw0KGgo") || pendingImageData.startsWith("/9j/"))) {
          const { saveImageAndIncrementRef } = await import("./image-refs.js");
          const { filePath, bytesWritten } = await saveImageAndIncrementRef(
            kv,
            pendingImageData,
          );
          raw.imageData = filePath;
          sdk.trigger({
            function_id: "mem::disk-size-delta",
            payload: { deltaBytes: bytesWritten },
            action: TriggerAction.Void(),
          });
          if (getEnvVar("AGENTMEMORY_IMAGE_EMBEDDINGS") === "true") {
            sdk.trigger({
              function_id: "mem::vision-embed",
              payload: {
                imageRef: filePath,
                sessionId: payload.sessionId,
                observationId: obsId,
              },
              action: TriggerAction.Void(),
            });
          }
        }

        try {

          await storeRawObservation(kv, raw);

        } catch (error) {
          if (raw.imageData) {
            // Roll back the ref taken above. decrementImageRef deletes the file
            // only when no other observation still references it (deduped images
            // survive) and emits the disk-size delta itself — deleting the file
            // directly here would orphan shared images and leave a stale ref.
            // If the rollback itself fails, log it but still surface the
            // original write error (the more useful failure to diagnose).
            try {
              const { decrementImageRef } = await import("./image-refs.js");
              await decrementImageRef(kv, sdk, raw.imageData);
            } catch (rollbackError) {
              logger.error("Failed to roll back image ref after observation write failure", {
                imageRef: raw.imageData,
                error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              });
            }
          }
          throw error;
        }

        if (dedupMap && dedupHash) {
          dedupMap.record(dedupHash);
        }

        publishToStreams(sdk, obsId, payload.sessionId, [
          {
            function_id: "stream::set",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.group(payload.sessionId),
              item_id: obsId,
              data: { type: "raw", observation: raw },
            },
          },
          {
            function_id: "stream::send",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.viewerGroup,
              id: `raw-${obsId}`,
              type: "raw_observation",
              data: { type: "raw", observation: raw, sessionId: payload.sessionId },
            },
          },
        ]);

        const session = existingSession;
        if (session) {
          const updates: Array<{ type: "set"; path: string; value: unknown }> = [
            { type: "set", path: "updatedAt", value: new Date().toISOString() },
            {
              type: "set",
              path: "observationCount",
              value: (session.observationCount || 0) + 1,
            },
          ];
          if (!session.firstPrompt && typeof raw.userPrompt === "string") {
            const trimmed = raw.userPrompt.replace(/\s+/g, " ").trim();
            if (trimmed.length > 0) {
              updates.push({
                type: "set",
                path: "firstPrompt",
                value: trimmed.slice(0, 200),
              });
            }
          }
          await kv.update(KV.sessions, payload.sessionId, updates);
          if (
            existingSession?.status === "completed" &&
            typeof payload.timestamp === "string" &&
            isAfter(payload.timestamp, existingSession.lastCheckpointAt ?? existingSession.endedAt) &&
            !postCompletionWarned.has(payload.sessionId)
          ) {
            postCompletionWarned.add(payload.sessionId);
            logger.warn("Post-completion session activity observed", {
              sessionId: payload.sessionId,
              endedAt: existingSession.endedAt,
              lastCheckpointAt: existingSession.lastCheckpointAt,
              timestamp: payload.timestamp,
            });
          }
        } else if (
          typeof payload.project === "string" &&
          payload.project.trim().length > 0 &&
          typeof payload.cwd === "string" &&
          payload.cwd.trim().length > 0
        ) {
          // OpenCode (and any plugin that skips POST /session/start)
          // can fire observations before the session record exists. Without
          // an implicit create, those observations stack up but
          // `memory_sessions` never lists them, and summarize bails with
          // "Session not found for summarize". Create the session now from
          // the observation payload — but only when project + cwd are
          // present (HookPayload contract). Older test payloads without
          // those fields keep their original no-op behaviour.
          const trimmedPrompt =
            typeof raw.userPrompt === "string"
              ? raw.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200)
              : undefined;
          const ts = new Date().toISOString();
          await kv.set(KV.sessions, payload.sessionId, {
            id: payload.sessionId,
            project: payload.project,
            cwd: payload.cwd,
            startedAt: payload.timestamp ?? ts,
            updatedAt: ts,
            status: "active",
            observationCount: 1,
            ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
            ...(trimmedPrompt && trimmedPrompt.length > 0
              ? { firstPrompt: trimmedPrompt }
              : {}),
          });
        }

        // Per-observation LLM compression is opt-in as of 0.8.8.
        // Default path: build a zero-LLM synthetic compression so recall
        // and BM25 search still work without burning the user's Claude
        // token allocation on every tool invocation.
        if (isAutoCompressEnabled()) {
          await sdk.trigger({
            function_id: "mem::compress",
            payload: {
              observationId: obsId,
              sessionId: payload.sessionId,
              raw,
              requireStoredRaw: true,
            },
            action: TriggerAction.Void(),
          });
        } else {
          const synthetic = buildSyntheticCompression(raw);
          await kv.set(
            KV.observations(payload.sessionId),
            obsId,
            synthetic,
          );
          getSearchIndex().add(synthetic);
          await vectorIndexAddGuarded(
            synthetic.id,
            synthetic.sessionId,
            synthetic.title + " " + (synthetic.narrative || ""),
            { kind: "synthetic", logId: synthetic.id },
          );
          await clearPendingCompression(
            kv,
            payload.sessionId,
            synthetic.id,
          );
          publishToStreams(sdk, obsId, payload.sessionId, [
            {
              function_id: "stream::set",
              payload: {
                stream_name: STREAM.name,
                group_id: STREAM.group(payload.sessionId),
                item_id: obsId,
                data: { type: "compressed", observation: synthetic },
              },
            },
            {
              function_id: "stream::set",
              payload: {
                stream_name: STREAM.name,
                group_id: STREAM.viewerGroup,
                item_id: obsId,
                data: {
                  type: "compressed",
                  observation: synthetic,
                  sessionId: payload.sessionId,
                },
              },
            },
          ]);
        }

        logger.info("Observation captured", {
          obsId,
          sessionId: payload.sessionId,
          hook: payload.hookType,
          compress: isAutoCompressEnabled() ? "llm" : "synthetic",
        });
        if (payload.hookType === "step_finish") {
          stepFinishCaptureCount++;
          if (stepFinishCaptureCount % STEP_FINISH_SAMPLE_EVERY === 0) {
            logger.info("Step-finish capture sample", {
              captured: stepFinishCaptureCount,
              sampleEvery: STEP_FINISH_SAMPLE_EVERY,
            });
          }
        }
        return { observationId: obsId };
      };
      return withObservationSessionOwnerLock(
        payload.sessionId,
        captureObservation,
      );
    },
  );
}
