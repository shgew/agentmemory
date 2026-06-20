import { describe, it, expect, vi, afterEach } from "vitest";

import { logger, bootLog, bootWarn, setBootVerbose } from "../src/logger.js";

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[agentmemory\] /;

function spyStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("logger timestamps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setBootVerbose(false);
  });

  it("prefixes info lines with an ISO-8601 UTC timestamp", () => {
    const spy = spyStderr();
    logger.info("hello world");
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toMatch(ISO_PREFIX);
    expect(line).toContain("[agentmemory] info hello world");
    expect(line.endsWith("\n")).toBe(true);
  });

  it("keeps serialized fields after the message", () => {
    const spy = spyStderr();
    logger.warn("with fields", { a: 1, b: "two" });
    const line = spy.mock.calls[0][0] as string;
    expect(line).toMatch(ISO_PREFIX);
    expect(line).toContain('[agentmemory] warn with fields {"a":1,"b":"two"}');
  });

  it("never throws on non-serializable fields and still timestamps", () => {
    const spy = spyStderr();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    logger.error("boom", circular);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toMatch(ISO_PREFIX);
    expect(line).toContain("[agentmemory] error boom");
  });

  it("prefixes bootWarn lines with a timestamp", () => {
    const spy = spyStderr();
    bootWarn("boot problem");
    const line = spy.mock.calls[0][0] as string;
    expect(line).toMatch(ISO_PREFIX);
    expect(line).toContain("[agentmemory] warn boot problem");
  });

  it("prefixes verbose bootLog lines with a timestamp", () => {
    setBootVerbose(true);
    const spy = spyStderr();
    bootLog("feature enabled");
    const line = spy.mock.calls[0][0] as string;
    expect(line).toMatch(ISO_PREFIX);
    expect(line).toContain("[agentmemory] feature enabled");
  });

  it("does not write quiet bootLog lines to stderr", () => {
    setBootVerbose(false);
    const spy = spyStderr();
    bootLog("buffered line");
    expect(spy).not.toHaveBeenCalled();
  });
});
