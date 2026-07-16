import { withKeyedLock } from "../state/keyed-mutex.js";

type ImageOwnershipWaiter = {
  mode: "read" | "write";
  start: (release: () => void) => void;
};

const imageOwnershipWaiters: ImageOwnershipWaiter[] = [];
let activeImageOwnershipReaders = 0;
let activeImageOwnershipWriter = false;

function drainImageOwnershipWaiters(): void {
  if (activeImageOwnershipWriter) return;
  if (activeImageOwnershipReaders > 0) {
    while (imageOwnershipWaiters[0]?.mode === "read") {
      startImageOwnershipWaiter(imageOwnershipWaiters.shift()!);
    }
    return;
  }
  const first = imageOwnershipWaiters.shift();
  if (!first) return;
  startImageOwnershipWaiter(first);
  if (first.mode === "read") {
    while (imageOwnershipWaiters[0]?.mode === "read") {
      startImageOwnershipWaiter(imageOwnershipWaiters.shift()!);
    }
  }
}

function startImageOwnershipWaiter(waiter: ImageOwnershipWaiter): void {
  if (waiter.mode === "write") activeImageOwnershipWriter = true;
  else activeImageOwnershipReaders++;
  let released = false;
  waiter.start(() => {
    if (released) return;
    released = true;
    if (waiter.mode === "write") activeImageOwnershipWriter = false;
    else activeImageOwnershipReaders--;
    drainImageOwnershipWaiters();
  });
}

function acquireImageOwnership(mode: "read" | "write"): Promise<() => void> {
  return new Promise((start) => {
    imageOwnershipWaiters.push({ mode, start });
    drainImageOwnershipWaiters();
  });
}

async function withImageOwnership<T>(
  mode: "read" | "write",
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireImageOwnership(mode);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function withImageOwnershipLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return withImageOwnership("write", operation);
}

export function withImageOwnershipReadLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return withImageOwnership("read", operation);
}

export function withObservationOwnerLock<T>(
  observationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(`image-owner:observation:${observationId}`, operation);
}

function withSortedKeyedLocks<T>(
  prefix: string,
  ids: readonly string[],
  operation: () => Promise<T>,
  index = 0,
): Promise<T> {
  return index === ids.length
    ? operation()
    : withKeyedLock(`${prefix}:${ids[index]}`, () =>
        withSortedKeyedLocks(prefix, ids, operation, index + 1),
      );
}

export function withObservationSessionLocks<T>(
  sessionIds: Iterable<string>,
  operation: () => Promise<T>,
): Promise<T> {
  const sortedSessionIds = [...new Set(sessionIds)].sort();
  return withSortedKeyedLocks("obs", sortedSessionIds, operation);
}

export function withObservationSessionLocksWithinOwnershipLock<T>(
  sessionIds: Iterable<string>,
  operation: () => Promise<T>,
): Promise<T> {
  const sortedSessionIds = [...new Set(sessionIds)].sort();
  return withSortedKeyedLocks("session", sortedSessionIds, () =>
    withSortedKeyedLocks("obs", sortedSessionIds, operation),
  );
}

export function withObservationSessionOwnershipLock<T>(
  sessionIds: Iterable<string>,
  operation: () => Promise<T>,
): Promise<T> {
  return withImageOwnershipLock(() =>
    withObservationSessionLocksWithinOwnershipLock(sessionIds, operation),
  );
}
