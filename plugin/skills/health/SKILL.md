---
name: health
description: Probe the agentmemory server and surface diagnostics (LLM/embedding providers, session counts, recent activity, stuck-item categories). Suggest memory_heal when issues are found. Use when the user says "health", "is agentmemory ok", "diagnose memory", "what's broken in memory", "memory status", or wants a quick wellness check.
argument-hint: ""
user-invocable: true
---

The user wants a health check on agentmemory.

## Quick start

```json
memory_diagnose {}
```

```json
memory_sessions { "limit": 5 }
```

Expected output:

```text
Server: reachable
LLM: openai (gpt-4o-mini) - healthy
Embedding: local (BGE-small) - healthy
Counts: 47 sessions, 1284 observations, 92 memories, 318 audit entries
Issues: none
Recent activity:
  - ses_a1b2c3d4 "jwt refresh rotation" - 31 obs - 2h ago - idle
  ...
```

## Why

Health is a diagnostic surface, not a guess. Only report what the tools returned. If the server is unreachable, that itself is the answer - do not invent a healthy report. If issues exist, name the remediation (`memory_heal`) explicitly.

## Workflow

1. Call `memory_diagnose` with default args. This returns the full diagnostic report: LLM providers, embedding providers, KV stats, and lease/sentinel/sketch/action issue counts.
2. If `memory_diagnose` did not return (network error, server down), stop. Surface "server unreachable" with the concrete recovery step: `npx @agentmemory/agentmemory` to start the daemon locally, or check `AGENTMEMORY_URL` for remote deployments.
3. Call `memory_sessions` with `limit: 5` to capture the 5 most recent sessions and their observation counts.
4. Present results in this exact order:
   - **Server reachability** - one line, healthy or not
   - **LLM provider** - which provider is configured (anthropic / openai / gemini / openrouter / minimax / agent-sdk / noop), is it healthy
   - **Embedding provider** - local / openai / voyage / gemini / cohere / openrouter, healthy
   - **Counts** - active sessions, total observations, total memories, audit entries
   - **Issues** - only list categories with non-zero counts; if all zero, say "none"
   - **Recent activity** - the 5 sessions from `memory_sessions` with title, status, observation count, and last activity time
5. If any issue category has > 0 entries, recommend `memory_heal` as the remediation step with one example invocation.
6. Never paraphrase or round tool output. Numbers come from the tools verbatim.

## Anti-patterns

WRONG: server returns null or throws, you respond "Looks healthy, no issues found."

RIGHT: server returns null, you respond "Server returned no response at http://localhost:3111. Start it with `npx @agentmemory/agentmemory`, then re-run /health."

WRONG: issues > 0 but you do not mention `memory_heal`.

RIGHT: "3 stuck actions detected. Run `memory_heal` (or `memory_heal { categories: 'actions' }` to scope) to release them."

## Checklist

- Every number came from the tool response, not from inference.
- Server unreachable is reported as unreachable, not as healthy.
- Issue categories with zero counts are omitted from the output.
- When any issue category is non-zero, `memory_heal` is named as the next step.

## See also

- `recall`: search past observations - works fine even when consolidation is stuck.
- `recap`: rollup of recent sessions, complements the recent-activity section here.
- `forget`: destructive cleanup, not part of a health check, but the natural follow-up if you want to drop stuck or junk memories.

## Troubleshooting

See ../_shared/TROUBLESHOOTING.md if `memory_diagnose` or `memory_sessions` is not available.
