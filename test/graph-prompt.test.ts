import { describe, it, expect } from "vitest";

import { GRAPH_EXTRACTION_SYSTEM } from "../src/prompts/graph-extraction.js";

describe("GRAPH_EXTRACTION_SYSTEM prompt", () => {
  it("instructs that relationship endpoints must reference a declared entity", () => {
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/declared/i);
  });

  it("includes a concrete few-shot example", () => {
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/Example/i);
  });
});
