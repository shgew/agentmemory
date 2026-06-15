export interface CronSpec {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
}

function parseField(
  field: string,
  min: number,
  max: number,
  label: string,
): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (!part) throw new Error(`Empty ${label} in cron field`);
    let range: string = part;
    let step = 1;
    const slashIdx = part.indexOf("/");
    if (slashIdx !== -1) {
      range = part.slice(0, slashIdx);
      const stepRaw = part.slice(slashIdx + 1);
      step = parseInt(stepRaw, 10);
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`Invalid step in cron ${label}: ${part}`);
      }
    }
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const dashIdx = range.indexOf("-");
      if (dashIdx !== -1) {
        lo = parseInt(range.slice(0, dashIdx), 10);
        hi = parseInt(range.slice(dashIdx + 1), 10);
      } else {
        lo = parseInt(range, 10);
        hi = slashIdx === -1 ? lo : max;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        throw new Error(`Invalid value in cron ${label}: ${part}`);
      }
      if (lo < min || hi > max || lo > hi) {
        throw new Error(
          `Out-of-range cron ${label} (${min}-${max}): ${part}`,
        );
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return Array.from(out).sort((a, b) => a - b);
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron must have 5 fields (minute hour dom month dow), got ${fields.length}: "${expr}"`,
    );
  }
  return {
    minute: parseField(fields[0], 0, 59, "minute"),
    hour: parseField(fields[1], 0, 23, "hour"),
    dom: parseField(fields[2], 1, 31, "day-of-month"),
    month: parseField(fields[3], 1, 12, "month"),
    dow: parseField(fields[4], 0, 6, "day-of-week"),
  };
}

export function nextCronFireMs(spec: CronSpec, from: Date = new Date()): number {
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (
      spec.month.includes(candidate.getMonth() + 1) &&
      spec.dom.includes(candidate.getDate()) &&
      spec.dow.includes(candidate.getDay()) &&
      spec.hour.includes(candidate.getHours()) &&
      spec.minute.includes(candidate.getMinutes())
    ) {
      const delta = candidate.getTime() - from.getTime();
      return delta > 0 ? delta : 0;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error("Cron expression has no match within one year");
}
