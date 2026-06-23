import { describe, it, expect } from "vitest";

import { GRAPH_EXTRACTION_SYSTEM } from "../src/prompts/graph-extraction.js";

describe("GRAPH_EXTRACTION_SYSTEM prompt", () => {
  it("instructs that relationship endpoints must reference a declared entity", () => {
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/declared/i);
  });

  it("includes a concrete few-shot example", () => {
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/Example/i);
  });

  it("exposes the full edge-type vocabulary including causal and temporal relations", () => {
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/caused_by/);
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/blocked_by/);
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/succeeded_by/);
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/rejected/);
  });

  it("exposes the full node-type vocabulary", () => {
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/project/);
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/organization/);
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/event/);
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/preference/);
  });

  it("frames related_to as a last-resort type, not a default", () => {
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/related_to/);
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/only when|last resort|none of/i);
  });

  it("gives relationship directionality guidance", () => {
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/direction/i);
  });
});
