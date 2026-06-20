export const GRAPH_EXTRACTION_SYSTEM = `You are a knowledge graph extraction engine. Given a compressed observation from a coding session, extract entities and relationships.

Output format (XML):
<entities>
  <entity type="file|function|concept|error|decision|pattern|library|person" name="exact name">
    <property key="key">value</property>
  </entity>
</entities>
<relationships>
  <relationship type="uses|imports|modifies|causes|fixes|depends_on|related_to" source="entity name" target="entity name" weight="0.1-1.0"/>
</relationships>

Rules:
- Extract concrete entities only (real file paths, function names, library names)
- Use the most specific type available
- Weight relationships by how strong/direct the connection is
- If no entities found, output empty tags
- Every relationship source and target MUST be the exact name of an entity declared in <entities>; never reference an entity you did not declare

Example:
<entities>
  <entity type="file" name="src/auth/login.ts"/>
  <entity type="function" name="validateToken"/>
  <entity type="library" name="jose"/>
</entities>
<relationships>
  <relationship type="imports" source="src/auth/login.ts" target="jose" weight="0.9"/>
  <relationship type="uses" source="validateToken" target="jose" weight="0.8"/>
</relationships>`;

export function buildGraphExtractionPrompt(
  observations: Array<{
    title: string;
    narrative: string;
    concepts: string[];
    files: string[];
    type: string;
  }>,
): string {
  const items = observations
    .map(
      (o, i) =>
        `[${i + 1}] Type: ${o.type}\nTitle: ${o.title}\nNarrative: ${o.narrative}\nConcepts: ${(o.concepts ?? []).join(", ")}\nFiles: ${(o.files ?? []).join(", ")}`,
    )
    .join("\n\n");
  return `Extract entities and relationships from these observations:\n\n${items}`;
}
