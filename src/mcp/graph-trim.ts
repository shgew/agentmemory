import type { GraphQueryResult, GraphNode, GraphEdge } from "../types.js";

const MAX_PROPERTY_KEYS = 10;
const MAX_PROPERTY_KEY_LENGTH = 300;
const MAX_STRING_LENGTH = 300;
const MAX_NAME_LENGTH = 300;

function boundPropertyValue(value: unknown): { value: unknown; truncated: boolean } {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? { value: value.slice(0, MAX_STRING_LENGTH), truncated: true }
      : { value, truncated: false };
  }
  const serialized = JSON.stringify(value) ?? String(value);
  return serialized.length > MAX_STRING_LENGTH
    ? { value: serialized.slice(0, MAX_STRING_LENGTH), truncated: true }
    : { value, truncated: false };
}

function trimNode(node: GraphNode): Record<string, unknown> {
  const entries = Object.entries(node.properties ?? {});
  const kept = entries.slice(0, MAX_PROPERTY_KEYS);
  let truncated = entries.length > kept.length;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of kept) {
    let outKey = key;
    if (key.length > MAX_PROPERTY_KEY_LENGTH) {
      outKey = key.slice(0, MAX_PROPERTY_KEY_LENGTH);
      truncated = true;
    }
    const bounded = boundPropertyValue(value);
    if (bounded.truncated) truncated = true;
    properties[outKey] = bounded.value;
  }
  const name =
    typeof node.name === "string" && node.name.length > MAX_NAME_LENGTH
      ? node.name.slice(0, MAX_NAME_LENGTH)
      : node.name;
  const out: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    name,
    properties,
    sourceObservationCount: node.sourceObservationIds?.length ?? 0,
  };
  if (truncated) out.propertiesTruncated = true;
  return out;
}

function trimEdge(edge: GraphEdge): Record<string, unknown> {
  return {
    id: edge.id,
    type: edge.type,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    weight: edge.weight,
    sourceObservationCount: edge.sourceObservationIds?.length ?? 0,
  };
}

export function trimGraphQueryForMcp(result: GraphQueryResult): unknown {
  const { nodes, edges, ...rest } = result;
  return {
    ...rest,
    nodes: (nodes ?? []).map(trimNode),
    edges: (edges ?? []).map(trimEdge),
  };
}
