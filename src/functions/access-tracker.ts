import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";
import { withImageOwnershipReadLock } from "./observation-lock.js";

const RECENT_CAP = 20;

export type AccessTarget =
  | {
      id: string;
      scope: "observation";
      sessionId: string;
    }
  | {
      id: string;
      scope: "memory" | "semantic" | "procedural" | "lesson";
    };

export interface AccessLog {
  memoryId: string;
  count: number;
  lastAt: string;
  recent: number[];
}

export function emptyAccessLog(memoryId: string): AccessLog {
  return { memoryId, count: 0, lastAt: "", recent: [] };
}

export function normalizeAccessLog(raw: unknown): AccessLog {
  const r = (raw ?? {}) as Partial<AccessLog>;
  const rawCount =
    typeof r.count === "number" && Number.isFinite(r.count) ? r.count : 0;
  const count = Math.max(0, Math.floor(rawCount));
  const rawRecent = Array.isArray(r.recent)
    ? r.recent.filter(
        (x): x is number => typeof x === "number" && Number.isFinite(x),
      )
    : [];
  const recent =
    rawRecent.length > RECENT_CAP ? rawRecent.slice(-RECENT_CAP) : rawRecent;
  return {
    memoryId: typeof r.memoryId === "string" ? r.memoryId : "",
    count: Math.max(count, recent.length),
    lastAt: typeof r.lastAt === "string" ? r.lastAt : "",
    recent,
  };
}

export async function getAccessLog(
  kv: StateKV,
  memoryId: string,
): Promise<AccessLog> {
  try {
    const raw = await kv.get<AccessLog>(KV.accessLog, memoryId);
    if (!raw) return emptyAccessLog(memoryId);
    const normalized = normalizeAccessLog(raw);
    if (!normalized.memoryId) normalized.memoryId = memoryId;
    return normalized;
  } catch {
    return emptyAccessLog(memoryId);
  }
}

function accessOwnerScope(target: AccessTarget): string | null {
  if (!target.id) return null;
  switch (target.scope) {
    case "observation":
      return target.sessionId ? KV.observations(target.sessionId) : null;
    case "memory":
      return KV.memories;
    case "semantic":
      return KV.semantic;
    case "procedural":
      return KV.procedural;
    case "lesson":
      return KV.lessons;
  }
}

export async function recordOwnedAccess(
  kv: StateKV,
  target: AccessTarget,
  timestampMs?: number,
): Promise<void> {
  const ownerScope = accessOwnerScope(target);
  if (!ownerScope) return;
  const ts = timestampMs ?? Date.now();
  try {
    await withImageOwnershipReadLock(() =>
      withKeyedLock(`mem:access:${target.id}`, async () => {
        const owner = await kv.get(ownerScope, target.id);
        if (!owner) return;
        const existing = await getAccessLog(kv, target.id);
        existing.count += 1;
        existing.lastAt = new Date(ts).toISOString();
        existing.recent.push(ts);
        if (existing.recent.length > RECENT_CAP) {
          existing.recent = existing.recent.slice(-RECENT_CAP);
        }
        await kv.set(KV.accessLog, target.id, existing);
      }),
    );
  } catch (err) {
    try {
      logger.warn("recordOwnedAccess failed", {
        memoryId: target.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {}
  }
}

export async function recordOwnedAccessBatch(
  kv: StateKV,
  targets: AccessTarget[],
  timestampMs?: number,
): Promise<void> {
  if (!targets || targets.length === 0) return;
  const ts = timestampMs ?? Date.now();
  const unique = new Map<string, AccessTarget>();
  for (const target of targets) {
    if (target.id && !unique.has(target.id)) unique.set(target.id, target);
  }
  await Promise.allSettled(
    [...unique.values()].map((target) => recordOwnedAccess(kv, target, ts)),
  );
}

export async function restoreOwnedAccessLogWithinOwnershipLock(
  kv: StateKV,
  target: AccessTarget,
  raw: unknown,
): Promise<boolean> {
  const ownerScope = accessOwnerScope(target);
  if (!ownerScope) return false;
  return withKeyedLock(`mem:access:${target.id}`, async () => {
    const owner = await kv.get(ownerScope, target.id);
    if (!owner) return false;
    const restored = normalizeAccessLog(raw);
    restored.memoryId = target.id;
    await kv.set(KV.accessLog, target.id, restored);
    return true;
  });
}

export async function deleteAccessLog(
  kv: StateKV,
  memoryId: string,
): Promise<void> {
  if (!memoryId) return;
  await withKeyedLock(`mem:access:${memoryId}`, async () => {
    await kv.delete(KV.accessLog, memoryId);
  });
}
