export function parseTimestampMs(ts: string | undefined | null): number {
  if (!ts) return Number.NEGATIVE_INFINITY;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function isAfter(a: string | undefined | null, b: string | undefined | null): boolean {
  return parseTimestampMs(a) > parseTimestampMs(b);
}

export function isAtOrBefore(a: string | undefined | null, b: string | undefined | null): boolean {
  return parseTimestampMs(a) <= parseTimestampMs(b);
}

export function laterTimestamp(
  a: string | undefined | null,
  b: string | undefined | null,
): string | undefined {
  if (!a && !b) return undefined;
  if (!a) return b ?? undefined;
  if (!b) return a;
  return parseTimestampMs(a) >= parseTimestampMs(b) ? a : b;
}
