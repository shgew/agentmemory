import type { ISdk } from "iii-sdk";
import type { PendingImageRelease, RawObservation, Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";
import { deleteAccessLog } from "./access-tracker.js";
import { flushIndexSave, getSearchIndex, vectorIndexRemove } from "./search.js";
import { deleteRawObservation } from "./raw-observations.js";
import {
  withImageOwnershipReadLock,
  withObservationOwnerLock,
} from "./observation-lock.js";

interface ImageBackedRecord {
  imageData?: string;
  imageRef?: string;
  sessionId?: string;
}

export interface ImageDeletionBatch {
  releaseIds: Set<string>;
}

const activeBatchedReleases = new Set<string>();

function imageRefs(...refs: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      refs.filter(
        (ref): ref is string => typeof ref === "string" && ref.length > 0,
      ),
    ),
  );
}

async function prepareImageRelease(
  kv: StateKV,
  id: string,
  refs: string[],
  details: Omit<PendingImageRelease, "id" | "refs">,
): Promise<PendingImageRelease> {
  const existing = await kv.get<PendingImageRelease>(KV.imageReleases, id);
  if (
    existing &&
    (existing.kind !== details.kind ||
      existing.scope !== details.scope ||
      existing.recordId !== details.recordId ||
      existing.sessionId !== details.sessionId ||
      existing.observationId !== details.observationId)
  ) {
    throw new Error("image release journal mismatch");
  }
  const release: PendingImageRelease = existing
    ? {
        ...existing,
        refs: imageRefs(...existing.refs, ...refs),
        ...(existing.owner === undefined && details.owner !== undefined
          ? { owner: details.owner }
          : {}),
        ...(existing.observation === undefined &&
        details.observation !== undefined
          ? { observation: details.observation }
          : {}),
        ...(existing.raw === undefined && details.raw !== undefined
          ? { raw: details.raw }
          : {}),
      }
    : { id, refs, ...details };
  await kv.set(KV.imageReleases, id, release);
  return release;
}

async function releaseImageRefs(
  sdk: ISdk,
  kv: StateKV,
  initial: PendingImageRelease,
): Promise<PendingImageRelease> {
  const { finalizeImageRefRelease, releaseImageRef } =
    await import("./image-refs.js");
  let release = initial;
  while ((release.finalizeRefs?.length ?? 0) > 0 || release.refs.length > 0) {
    const finalizeRef = release.finalizeRefs?.[0];
    if (finalizeRef) {
      await finalizeImageRefRelease(kv, finalizeRef, release.id);
      release = {
        ...release,
        finalizeRefs: release.finalizeRefs?.slice(1),
      };
      await kv.set(KV.imageReleases, release.id, release);
      continue;
    }
    const imageRef = release.refs[0];
    await releaseImageRef(kv, sdk, imageRef, release.id);
    release = {
      ...release,
      refs: release.refs.slice(1),
      finalizeRefs: [...(release.finalizeRefs ?? []), imageRef],
    };
    await kv.set(KV.imageReleases, release.id, release);
  }
  return release;
}

async function markObservationCountAdjusted(
  kv: StateKV,
  release: PendingImageRelease,
  sessionId: string,
): Promise<PendingImageRelease> {
  if (release.observationCountAdjusted) return release;
  const session = await kv.get<Session>(KV.sessions, sessionId);
  if (session) {
    const applied = session.appliedObservationDeletionIds ?? [];
    if (!applied.includes(release.id)) {
      const currentCount =
        typeof session.observationCount === "number" &&
        Number.isFinite(session.observationCount)
          ? Math.max(0, Math.floor(session.observationCount))
          : 0;
      await kv.update<Session>(KV.sessions, sessionId, [
        {
          type: "set",
          path: "observationCount",
          value: Math.max(0, currentCount - 1),
        },
        {
          type: "set",
          path: "appliedObservationDeletionIds",
          value: [...applied, release.id],
        },
      ]);
    }
  }
  const adjusted = { ...release, observationCountAdjusted: true };
  await kv.set(KV.imageReleases, adjusted.id, adjusted);
  return adjusted;
}

async function clearObservationCountToken(
  kv: StateKV,
  release: PendingImageRelease,
  sessionId: string,
): Promise<PendingImageRelease> {
  if (release.observationCountFinalized) return release;
  const session = await kv.get<Session>(KV.sessions, sessionId);
  if (session?.appliedObservationDeletionIds?.includes(release.id)) {
    await kv.update<Session>(KV.sessions, sessionId, [
      {
        type: "set",
        path: "appliedObservationDeletionIds",
        value: session.appliedObservationDeletionIds.filter(
          (id) => id !== release.id,
        ),
      },
    ]);
  }
  const finalized = { ...release, observationCountFinalized: true };
  await kv.set(KV.imageReleases, finalized.id, finalized);
  return finalized;
}

async function finalizeDerivedState(
  kv: StateKV,
  release: PendingImageRelease,
  targetId: string,
  batch?: ImageDeletionBatch,
): Promise<PendingImageRelease> {
  if (release.derivedCleanupComplete) return release;
  await deleteAccessLog(kv, targetId);
  getSearchIndex().remove(targetId);
  vectorIndexRemove(targetId);
  if (batch) {
    batch.releaseIds.add(release.id);
    activeBatchedReleases.add(release.id);
    return release;
  }
  await flushIndexSave();
  const completed = { ...release, derivedCleanupComplete: true };
  await kv.set(KV.imageReleases, completed.id, completed);
  return completed;
}

async function finalizeImageDeletionBatch(
  kv: StateKV,
  batch: ImageDeletionBatch,
): Promise<void> {
  if (batch.releaseIds.size === 0) return;
  await flushIndexSave();
  for (const releaseId of batch.releaseIds) {
    const release = await kv.get<PendingImageRelease>(
      KV.imageReleases,
      releaseId,
    );
    if (!release) continue;
    if (!release.derivedCleanupComplete) {
      await kv.set(KV.imageReleases, releaseId, {
        ...release,
        derivedCleanupComplete: true,
      });
    }
    await kv.delete(KV.imageReleases, releaseId);
  }
}

export async function withImageDeletionBatch<T>(
  kv: StateKV,
  operation: (batch: ImageDeletionBatch) => Promise<T>,
): Promise<T> {
  const batch: ImageDeletionBatch = { releaseIds: new Set() };
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation(batch);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await finalizeImageDeletionBatch(kv, batch);
  } finally {
    for (const releaseId of batch.releaseIds) {
      activeBatchedReleases.delete(releaseId);
    }
  }
  if (operationFailed) throw operationError;
  return result as T;
}

export async function deleteImageBackedRecord<T extends ImageBackedRecord>(
  sdk: ISdk,
  kv: StateKV,
  scope: string,
  id: string,
  batch?: ImageDeletionBatch,
): Promise<T | null> {
  return withImageOwnershipReadLock(() =>
    withKeyedLock(`image-owner:${scope}:${id}`, async () => {
      const releaseId = `record:${scope}:${id}`;
      const [record, pendingRelease] = await Promise.all([
        kv.get<T>(scope, id),
        kv.get<PendingImageRelease>(KV.imageReleases, releaseId),
      ]);
      if (!record && pendingRelease && activeBatchedReleases.has(releaseId)) {
        return null;
      }
      if (!record && !pendingRelease) return null;

      const owner = record ?? (pendingRelease?.owner as T | undefined);
      const release = await prepareImageRelease(
        kv,
        releaseId,
        imageRefs(record?.imageData, record?.imageRef),
        {
          kind: "record",
          scope,
          recordId: id,
          ...(owner ? { owner } : {}),
        },
      );

      if (record) await kv.delete(scope, id);
      let completed = await releaseImageRefs(sdk, kv, release);
      completed = await finalizeDerivedState(kv, completed, id, batch);
      if (completed.derivedCleanupComplete) {
        await kv.delete(KV.imageReleases, completed.id);
      }
      return owner ?? null;
    }),
  );
}

export async function deleteObservationOwnersWithinSessionLock<
  T extends ImageBackedRecord,
>(
  sdk: ISdk,
  kv: StateKV,
  sessionId: string,
  observationId: string,
  batch?: ImageDeletionBatch,
): Promise<{ observation: T | null; raw: RawObservation | null } | null> {
  return withObservationOwnerLock(observationId, async () => {
    const releaseId = `observation:${sessionId}:${observationId}`;
    const [observation, raw, pendingRelease] = await Promise.all([
      kv.get<T>(KV.observations(sessionId), observationId),
      kv.get<RawObservation>(KV.rawPayloads, observationId),
      kv.get<PendingImageRelease>(KV.imageReleases, releaseId),
    ]);
    if (
      pendingRelease &&
      (pendingRelease.kind !== "observation" ||
        pendingRelease.sessionId !== sessionId ||
        pendingRelease.observationId !== observationId)
    ) {
      throw new Error("observation session mismatch");
    }
    const storedObservation =
      observation ?? (pendingRelease?.observation as T | undefined) ?? null;
    const storedRaw = raw ?? pendingRelease?.raw ?? null;
    if (
      storedRaw?.sessionId !== undefined &&
      storedRaw.sessionId !== sessionId
    ) {
      throw new Error("observation session mismatch");
    }
    if (
      storedObservation?.sessionId !== undefined &&
      storedObservation.sessionId !== sessionId
    ) {
      throw new Error("observation session mismatch");
    }
    if (!observation && !raw && !pendingRelease) return null;
    if (
      !observation &&
      !raw &&
      pendingRelease &&
      activeBatchedReleases.has(releaseId)
    ) {
      return null;
    }

    let release = await prepareImageRelease(
      kv,
      releaseId,
      imageRefs(observation?.imageData, observation?.imageRef, raw?.imageData),
      {
        kind: "observation",
        sessionId,
        observationId,
        ...(storedObservation ? { observation: storedObservation } : {}),
        ...(storedRaw ? { raw: storedRaw } : {}),
      },
    );

    if (observation) {
      await kv.delete(KV.observations(sessionId), observationId);
    }
    if (raw) await deleteRawObservation(kv, sessionId, observationId);
    release = await markObservationCountAdjusted(kv, release, sessionId);
    release = await releaseImageRefs(sdk, kv, release);
    release = await clearObservationCountToken(kv, release, sessionId);
    release = await finalizeDerivedState(kv, release, observationId, batch);
    if (release.derivedCleanupComplete) {
      await kv.delete(KV.imageReleases, release.id);
    }
    return { observation: storedObservation, raw: storedRaw };
  });
}

export async function withObservationSessionOwnerLock<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withImageOwnershipReadLock(() =>
    withKeyedLock(`session:${sessionId}`, () =>
      withKeyedLock(`obs:${sessionId}`, operation),
    ),
  );
}

export async function deleteObservationOwners<T extends ImageBackedRecord>(
  sdk: ISdk,
  kv: StateKV,
  sessionId: string,
  observationId: string,
  batch?: ImageDeletionBatch,
): Promise<{ observation: T | null; raw: RawObservation | null } | null> {
  return withObservationSessionOwnerLock(sessionId, () =>
    deleteObservationOwnersWithinSessionLock<T>(
      sdk,
      kv,
      sessionId,
      observationId,
      batch,
    ),
  );
}

export async function drainPendingImageReleases(
  sdk: ISdk,
  kv: StateKV,
): Promise<{ completed: number; failed: number }> {
  const releases = await kv.list<PendingImageRelease>(KV.imageReleases);
  let completed = 0;
  let failed = 0;
  for (const release of releases) {
    try {
      const targetId =
        release.kind === "record" ? release.recordId : release.observationId;
      if (!targetId) throw new Error("invalid image release journal");
      if (release.kind === "record" && release.scope && release.recordId) {
        await deleteImageBackedRecord(sdk, kv, release.scope, release.recordId);
      } else if (
        release.kind === "observation" &&
        release.sessionId &&
        release.observationId
      ) {
        await deleteObservationOwners(
          sdk,
          kv,
          release.sessionId,
          release.observationId,
        );
      } else {
        throw new Error("invalid image release journal");
      }
      completed++;
    } catch (error) {
      failed++;
      logger.warn("Pending image release failed", {
        releaseId: release.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { completed, failed };
}
