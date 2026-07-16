import { getEnvVar } from "../config.js";

const EMBED_MAX_CHARS = 16_000;
const DEFAULT_REBUILD_EMBED_BATCH = 32;

export function clipEmbedInput(text: string): string {
  return text.length <= EMBED_MAX_CHARS ? text : text.slice(0, EMBED_MAX_CHARS);
}

export function getRebuildEmbedBatchSize(): number {
  const raw = getEnvVar("REBUILD_EMBED_BATCH_SIZE");
  if (!raw) return DEFAULT_REBUILD_EMBED_BATCH;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REBUILD_EMBED_BATCH;
}
