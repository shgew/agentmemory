import { TriggerAction, type ISdk } from "iii-sdk";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  deleteImage,
  imagePathForData,
  saveImageToDisk,
  touchImage,
} from "../utils/image-store.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

interface ImageRefState {
  count: number;
  appliedReleaseIds: string[];
}

function normalizeImageRefState(value: unknown): ImageRefState {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { count: Math.max(0, Math.floor(value)), appliedReleaseIds: [] };
  }
  if (!value || typeof value !== "object") {
    return { count: 0, appliedReleaseIds: [] };
  }
  const stored = value as Partial<ImageRefState>;
  const count =
    typeof stored.count === "number" && Number.isFinite(stored.count)
      ? Math.max(0, Math.floor(stored.count))
      : 0;
  const appliedReleaseIds = Array.isArray(stored.appliedReleaseIds)
    ? stored.appliedReleaseIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];
  return { count, appliedReleaseIds };
}

async function getImageRefState(
  kv: StateKV,
  filePath: string,
): Promise<ImageRefState> {
  return normalizeImageRefState(await kv.get(KV.imageRefs, filePath));
}

async function deleteUnreferencedImage(
  kv: StateKV,
  sdk: ISdk,
  filePath: string,
): Promise<void> {
  await kv.delete(KV.imageEmbeddings, filePath);
  const { deletedBytes } = await deleteImage(filePath);
  if (deletedBytes > 0) {
    sdk.trigger({
      function_id: "mem::disk-size-delta",
      payload: { deltaBytes: -deletedBytes },
      action: TriggerAction.Void(),
    });
  }
}

export async function getImageRefCount(
  kv: StateKV,
  filePath: string,
): Promise<number> {
  return (await getImageRefState(kv, filePath)).count;
}

export async function incrementImageRef(
  kv: StateKV,
  filePath: string,
): Promise<void> {
  return withKeyedLock(`imgRef:${filePath}`, async () => {
    await incrementImageRefUnderLock(kv, filePath);
    await touchImage(filePath);
  });
}

async function incrementImageRefUnderLock(
  kv: StateKV,
  filePath: string,
): Promise<void> {
  const current = await getImageRefState(kv, filePath);
  const count = current.count + 1;
  await kv.set(
    KV.imageRefs,
    filePath,
    current.appliedReleaseIds.length > 0 ? { ...current, count } : count,
  );
}

export async function saveImageAndIncrementRef(
  kv: StateKV,
  base64Data: string,
): Promise<{ filePath: string; bytesWritten: number }> {
  const filePath = imagePathForData(base64Data);
  if (!filePath) return { filePath: "", bytesWritten: 0 };
  return withKeyedLock(`imgRef:${filePath}`, async () => {
    const saved = await saveImageToDisk(base64Data);
    await incrementImageRefUnderLock(kv, saved.filePath);
    await touchImage(saved.filePath);
    return saved;
  });
}

export async function decrementImageRef(
  kv: StateKV,
  sdk: ISdk,
  filePath: string,
): Promise<void> {
  return withKeyedLock(`imgRef:${filePath}`, async () => {
    const current = await getImageRefState(kv, filePath);
    if (current.count <= 1) {
      if (current.appliedReleaseIds.length > 0) {
        await kv.set(KV.imageRefs, filePath, { ...current, count: 0 });
      } else {
        await kv.delete(KV.imageRefs, filePath);
      }
      await deleteUnreferencedImage(kv, sdk, filePath);
    } else {
      const count = current.count - 1;
      await kv.set(
        KV.imageRefs,
        filePath,
        current.appliedReleaseIds.length > 0 ? { ...current, count } : count,
      );
    }
  });
}

export async function releaseImageRef(
  kv: StateKV,
  sdk: ISdk,
  filePath: string,
  releaseId: string,
): Promise<void> {
  return withKeyedLock(`imgRef:${filePath}`, async () => {
    let state = await getImageRefState(kv, filePath);
    if (!state.appliedReleaseIds.includes(releaseId)) {
      state = {
        count: Math.max(0, state.count - 1),
        appliedReleaseIds: [...state.appliedReleaseIds, releaseId],
      };
      await kv.set(KV.imageRefs, filePath, state);
    }
    if (state.count === 0) {
      await deleteUnreferencedImage(kv, sdk, filePath);
    }
  });
}

export async function finalizeImageRefRelease(
  kv: StateKV,
  filePath: string,
  releaseId: string,
): Promise<void> {
  return withKeyedLock(`imgRef:${filePath}`, async () => {
    const stored = await kv.get(KV.imageRefs, filePath);
    if (typeof stored === "number" || !stored) return;
    const state = normalizeImageRefState(stored);
    if (!state.appliedReleaseIds.includes(releaseId)) return;
    const appliedReleaseIds = state.appliedReleaseIds.filter(
      (id) => id !== releaseId,
    );
    if (state.count === 0) {
      await kv.delete(KV.imageRefs, filePath);
    } else if (appliedReleaseIds.length === 0) {
      await kv.set(KV.imageRefs, filePath, state.count);
    } else {
      await kv.set(KV.imageRefs, filePath, { ...state, appliedReleaseIds });
    }
  });
}
