import { describe, it, expect, afterEach } from "vitest";
import { isGraphSearchEnabled } from "../src/config.js";

// Deliverable #1: GRAPH_SEARCH_ENABLED is a true kill switch for graph
// consumption in hybrid search. It follows the exact same pattern as
// isGraphExtractionEnabled: default false, `true` only when the value is
// exactly the string "true" (adversarial MALFORMED INPUT class — "TRUE" / "1"
// / "" must all read as false).
describe("isGraphSearchEnabled", () => {
  const original = process.env.GRAPH_SEARCH_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.GRAPH_SEARCH_ENABLED;
    else process.env.GRAPH_SEARCH_ENABLED = original;
  });

  it("returns false when GRAPH_SEARCH_ENABLED is unset (default)", () => {
    delete process.env.GRAPH_SEARCH_ENABLED;
    expect(isGraphSearchEnabled()).toBe(false);
  });

  it("returns true for the exact string 'true'", () => {
    process.env.GRAPH_SEARCH_ENABLED = "true";
    expect(isGraphSearchEnabled()).toBe(true);
  });

  it("treats 'TRUE' as false (exact-match only)", () => {
    process.env.GRAPH_SEARCH_ENABLED = "TRUE";
    expect(isGraphSearchEnabled()).toBe(false);
  });

  it("treats '1' as false", () => {
    process.env.GRAPH_SEARCH_ENABLED = "1";
    expect(isGraphSearchEnabled()).toBe(false);
  });

  it("treats the empty string as false", () => {
    process.env.GRAPH_SEARCH_ENABLED = "";
    expect(isGraphSearchEnabled()).toBe(false);
  });
});
