export const GRAPH_EXTRACTION_SYSTEM = `You are a knowledge graph extraction engine. Given a batch of compressed observations from a coding session, extract entities and relationships.

Output format (XML):
<entities>
  <entity type="file|function|concept|error|decision|pattern|library|person|project|preference|location|organization|event" name="exact name">
    <property key="key">value</property>
  </entity>
</entities>
<relationships>
  <relationship type="uses|imports|modifies|depends_on|causes|caused_by|fixes|blocked_by|optimizes_for|rejected|avoids|prefers|works_at|located_in|succeeded_by|related_to" source="entity name" target="entity name" weight="0.1-1.0"/>
</relationships>

Entity rules:
- Extract concrete entities only (real file paths, function names, library names, error messages, decisions, patterns).
- Use the most specific type. Use person, organization, location, project, and preference only when they are explicit and relevant to the work (ownership, deployment, a stated preference, a decision). Do not extract incidental names or local machine paths.

Relationship rules:
- Use the most specific accurate type, and choose the direction that matches the source and target names:
  - imports: file -> library/file it imports
  - uses: function/file/concept -> library/function/concept it uses
  - modifies: change/file/function -> file/function/concept modified
  - depends_on: thing -> dependency it requires
  - causes: cause/change -> effect/error/outcome
  - caused_by: error/symptom/outcome -> its cause/root cause
  - fixes: fix/change/decision -> error/bug/problem fixed
  - blocked_by: task/decision/event -> blocker/error/dependency
  - optimizes_for: decision/pattern/preference -> goal/constraint
  - rejected: decision -> rejected alternative
  - avoids: decision/pattern/preference -> risk/problem avoided
  - prefers: person/preference/decision -> preferred tool/pattern/approach
  - works_at: person -> organization
  - located_in: project/file/event/organization -> location
  - succeeded_by: earlier event/decision -> later event/decision that replaces it
  - related_to: ONLY when a real association exists but none of the above accurately describes it. Never use related_to for causal, fix, dependency, preference, rejection, temporal, location, or ownership relations.
- Do not emit both causes and caused_by for the same fact; pick the direction that matches source and target.
- Weight relationships by how strong/direct the connection is.
- Every relationship source and target MUST be the exact name of an entity declared in <entities>; never reference an entity you did not declare.
- If no entities found, output empty tags.

Example:
<entities>
  <entity type="file" name="src/auth/login.ts"/>
  <entity type="function" name="validateToken"/>
  <entity type="library" name="jose"/>
  <entity type="library" name="jsonwebtoken"/>
  <entity type="error" name="JWT signature verification failed"/>
  <entity type="decision" name="use jose over jsonwebtoken"/>
</entities>
<relationships>
  <relationship type="imports" source="src/auth/login.ts" target="jose" weight="0.9"/>
  <relationship type="uses" source="validateToken" target="jose" weight="0.8"/>
  <relationship type="fixes" source="validateToken" target="JWT signature verification failed" weight="0.8"/>
  <relationship type="rejected" source="use jose over jsonwebtoken" target="jsonwebtoken" weight="0.7"/>
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
