import { describe, it, expect } from "vitest";
import { trimGraphQueryForMcp } from "../src/mcp/graph-trim.js";
import type { GraphQueryResult } from "../src/types.js";

const longValue = "L".repeat(400);

function fixture(): GraphQueryResult {
  return {
    nodes: [
      {
        id: "n1",
        type: "file",
        name: "x",
        sourceObservationIds: ["a", "b", "c"],
        properties: {
          longKey: longValue,
          p1: "1",
          p2: "2",
          p3: "3",
          p4: "4",
          p5: "5",
          p6: "6",
          p7: "7",
          p8: "8",
          p9: "9",
          p10: "10",
          p11: "11",
        },
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "n2",
        type: "function",
        name: "y",
        sourceObservationIds: [],
        properties: { a: "1", b: "2", c: "3" },
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    edges: [
      {
        id: "e1",
        type: "uses",
        sourceNodeId: "n1",
        targetNodeId: "n2",
        weight: 0.9,
        sourceObservationIds: ["x", "y"],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    depth: 2,
    totalNodes: 7,
    totalEdges: 3,
    truncated: true,
    limit: 50,
    offset: 0,
    fromSnapshot: true,
    warning: "w",
  };
}

describe("trimGraphQueryForMcp", () => {
  it("strips sourceObservationIds, adds counts, caps node properties", () => {
    const trimmed = trimGraphQueryForMcp(fixture()) as any;

    const n1 = trimmed.nodes[0];
    expect(n1.sourceObservationIds).toBeUndefined();
    expect(n1.sourceObservationCount).toBe(3);
    expect(Object.keys(n1.properties).length).toBe(10);
    expect(n1.properties.longKey.length).toBeLessThanOrEqual(303);
    expect(n1.propertiesTruncated).toBe(true);

    const n2 = trimmed.nodes[1];
    expect(n2.propertiesTruncated).toBeFalsy();
    expect(n2.sourceObservationCount).toBe(0);

    const e1 = trimmed.edges[0];
    expect(e1.sourceObservationIds).toBeUndefined();
    expect(e1.sourceObservationCount).toBe(2);

    expect(trimmed.depth).toBe(2);
    expect(trimmed.totalNodes).toBe(7);
    expect(trimmed.totalEdges).toBe(3);
    expect(trimmed.truncated).toBe(true);
    expect(trimmed.limit).toBe(50);
    expect(trimmed.offset).toBe(0);
    expect(trimmed.fromSnapshot).toBe(true);
    expect(trimmed.warning).toBe("w");
  });

  it("does not mutate the input", () => {
    const input = fixture();
    trimGraphQueryForMcp(input);
    expect(input.nodes[0].sourceObservationIds).toEqual(["a", "b", "c"]);
    expect(Object.keys(input.nodes[0].properties).length).toBe(12);
    expect((input.nodes[0].properties.longKey as string).length).toBe(400);
    expect(input.edges[0].sourceObservationIds).toEqual(["x", "y"]);
  });

  it("bounds node name and non-string property values", () => {
    const result: GraphQueryResult = {
      nodes: [
        {
          id: "n1",
          type: "file",
          name: "N".repeat(500),
          sourceObservationIds: [],
          properties: {
            big: { nested: "Z".repeat(500) },
            arr: Array(200).fill("x"),
          },
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      edges: [],
      depth: 0,
      totalNodes: 1,
      totalEdges: 0,
      truncated: false,
      limit: 50,
      offset: 0,
    };
    const trimmed = trimGraphQueryForMcp(result) as any;
    const n1 = trimmed.nodes[0];
    expect(n1.name.length).toBeLessThanOrEqual(300);
    expect(typeof n1.properties.big).toBe("string");
    expect((n1.properties.big as string).length).toBeLessThanOrEqual(300);
    expect(typeof n1.properties.arr).toBe("string");
    expect((n1.properties.arr as string).length).toBeLessThanOrEqual(300);
    expect(n1.propertiesTruncated).toBe(true);
  });
});


describe("trimGraphQueryForMcp strict bounds", () => {
  it("bounds long property keys", () => {
    const hugeKey = "K".repeat(500);
    const result = {
      nodes: [
        {
          id: "n1",
          type: "file",
          name: "x",
          sourceObservationIds: [],
          properties: { [hugeKey]: "v" },
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      edges: [],
      depth: 0,
      totalNodes: 1,
      totalEdges: 0,
      truncated: false,
      limit: 50,
      offset: 0,
    } as GraphQueryResult;
    const trimmed = trimGraphQueryForMcp(result) as any;
    const keys = Object.keys(trimmed.nodes[0].properties);
    expect(keys).toHaveLength(1);
    expect(keys[0].length).toBeLessThanOrEqual(300);
    expect(trimmed.nodes[0].propertiesTruncated).toBe(true);
  });

  it("allowlists node and edge fields, dropping aliases and edge context", () => {
    const result = {
      nodes: [
        {
          id: "n1",
          type: "file",
          name: "x",
          sourceObservationIds: [],
          properties: {},
          createdAt: "2026-01-01T00:00:00Z",
          aliases: ["a1", "a2"],
          stale: false,
        },
      ],
      edges: [
        {
          id: "e1",
          type: "uses",
          sourceNodeId: "n1",
          targetNodeId: "n2",
          weight: 0.5,
          sourceObservationIds: [],
          createdAt: "2026-01-01T00:00:00Z",
          context: { reasoning: "why" },
        },
      ],
      depth: 0,
      totalNodes: 1,
      totalEdges: 1,
      truncated: false,
      limit: 50,
      offset: 0,
    } as unknown as GraphQueryResult;
    const trimmed = trimGraphQueryForMcp(result) as any;
    expect(trimmed.nodes[0].aliases).toBeUndefined();
    expect(trimmed.nodes[0].stale).toBeUndefined();
    expect(trimmed.edges[0].context).toBeUndefined();
    expect(trimmed.edges[0].weight).toBe(0.5);
    expect(trimmed.edges[0].sourceObservationCount).toBe(0);
  });
});