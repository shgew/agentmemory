import { describe, it, expect } from "vitest";
import { parseCron, nextCronFireMs } from "../src/state/cron.js";

describe("parseCron", () => {
  it("parses '0 3 * * *' (3 AM daily)", () => {
    const spec = parseCron("0 3 * * *");
    expect(spec.minute).toEqual([0]);
    expect(spec.hour).toEqual([3]);
    expect(spec.dom.length).toBe(31);
    expect(spec.month.length).toBe(12);
    expect(spec.dow.length).toBe(7);
  });

  it("parses '*/15 * * * *' (every 15 minutes)", () => {
    const spec = parseCron("*/15 * * * *");
    expect(spec.minute).toEqual([0, 15, 30, 45]);
    expect(spec.hour.length).toBe(24);
  });

  it("parses '0 22 * * 1-5' (10 PM on weekdays)", () => {
    const spec = parseCron("0 22 * * 1-5");
    expect(spec.minute).toEqual([0]);
    expect(spec.hour).toEqual([22]);
    expect(spec.dow).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses '30 2,14 * * *' (2:30 AM and 2:30 PM)", () => {
    const spec = parseCron("30 2,14 * * *");
    expect(spec.minute).toEqual([30]);
    expect(spec.hour).toEqual([2, 14]);
  });

  it("parses '0 */6 * * *' (every 6 hours)", () => {
    const spec = parseCron("0 */6 * * *");
    expect(spec.hour).toEqual([0, 6, 12, 18]);
  });

  it("rejects wrong field count", () => {
    expect(() => parseCron("0 3 * *")).toThrow(/5 fields/);
    expect(() => parseCron("0 3 * * * *")).toThrow(/5 fields/);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCron("0 24 * * *")).toThrow(/Out-of-range/);
    expect(() => parseCron("60 0 * * *")).toThrow(/Out-of-range/);
    expect(() => parseCron("0 0 0 * *")).toThrow(/Out-of-range/);
    expect(() => parseCron("0 0 * 13 *")).toThrow(/Out-of-range/);
    expect(() => parseCron("0 0 * * 7")).toThrow(/Out-of-range/);
  });

  it("rejects zero step", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
  });
});

describe("nextCronFireMs", () => {
  it("returns time until next 3 AM when current is 1 AM", () => {
    const spec = parseCron("0 3 * * *");
    const from = new Date(2026, 0, 15, 1, 0, 0);
    const ms = nextCronFireMs(spec, from);
    expect(ms).toBe(2 * 60 * 60 * 1000);
  });

  it("rolls over to next day when current is past schedule", () => {
    const spec = parseCron("0 3 * * *");
    const from = new Date(2026, 0, 15, 4, 0, 0);
    const ms = nextCronFireMs(spec, from);
    expect(ms).toBe(23 * 60 * 60 * 1000);
  });

  it("hits 3:00 exactly on the minute boundary", () => {
    const spec = parseCron("0 3 * * *");
    const from = new Date(2026, 0, 15, 2, 59, 30);
    const ms = nextCronFireMs(spec, from);
    expect(ms).toBe(30 * 1000);
  });

  it("respects day-of-week restriction (weekdays only)", () => {
    const spec = parseCron("0 3 * * 1-5");
    const saturday = new Date(2026, 0, 17, 4, 0, 0);
    const ms = nextCronFireMs(spec, saturday);
    const next = new Date(saturday.getTime() + ms);
    expect([1, 2, 3, 4, 5]).toContain(next.getDay());
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
  });

  it("rolls across month boundary", () => {
    const spec = parseCron("0 3 * * *");
    const lastDay = new Date(2026, 0, 31, 5, 0, 0);
    const ms = nextCronFireMs(spec, lastDay);
    const next = new Date(lastDay.getTime() + ms);
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(3);
  });

  it("fires within the next 24h for daily schedule", () => {
    const spec = parseCron("0 3 * * *");
    const ms = nextCronFireMs(spec, new Date());
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("handles '0 */6 * * *' (every 6 hours)", () => {
    const spec = parseCron("0 */6 * * *");
    const from = new Date(2026, 0, 15, 1, 30, 0);
    const ms = nextCronFireMs(spec, from);
    expect(ms).toBe(4.5 * 60 * 60 * 1000);
  });

  it("throws on impossible cron like Feb 31 (no match within one year)", () => {
    const spec = parseCron("0 0 31 2 *");
    expect(() => nextCronFireMs(spec)).toThrow(/no match within one year/);
  });
});
