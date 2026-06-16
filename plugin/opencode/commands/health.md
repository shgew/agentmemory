Check the agentmemory server health, configured providers, and recent observation count. Wraps the `memory_diagnose` MCP tool plus a `GET /agentmemory/health` probe.

## Usage

```
/health
```

## Instructions

1. Call `memory_diagnose` with default args. This returns the full diagnostic report (LLM providers, embedding providers, KV stats, lease/sentinel/sketch issues, stuck actions).
2. Call `memory_sessions` with `limit: 5` to get the 5 most recent sessions and their observation counts.
3. Present results in this order:
   - **Server reachability** - did `memory_diagnose` return? (if not, surface "server unreachable" and stop)
   - **LLM provider** - which provider is configured (anthropic / openai / gemini / openrouter / minimax / agent-sdk / noop), is it healthy?
   - **Embedding provider** - local / openai / voyage / gemini / cohere / openrouter, healthy?
   - **Counts** - active sessions, total observations, total memories, audit entries
   - **Issues** - count of stuck/orphaned items by category, but only mention categories with non-zero counts
   - **Recent activity** - the 5 sessions from `memory_sessions` with title, status, observation count, and last activity time
4. If issues > 0 in any category, suggest `memory_heal` as the remediation step.
5. **Never hallucinate**. Only present what the MCP tools actually returned.
