# health worked examples

## 1. Server healthy, no issues

User: "Is agentmemory ok?"

Invocations:

```json
memory_diagnose {}
```

```json
memory_sessions { "limit": 5 }
```

Diagnose response:

```json
{
  "server": "reachable",
  "llm": { "provider": "openai", "model": "gpt-4o-mini", "healthy": true },
  "embedding": { "provider": "local", "model": "BGE-small", "healthy": true },
  "counts": { "sessions": 47, "observations": 1284, "memories": 92, "audit": 318 },
  "issues": { "actions": 0, "leases": 0, "sentinels": 0, "sketches": 0 }
}
```

Sessions response: 5 recent sessions, all clean.

Present:

> **Server**: reachable.
> **LLM**: openai (gpt-4o-mini) - healthy.
> **Embedding**: local (BGE-small) - healthy.
> **Counts**: 47 sessions, 1,284 observations, 92 memories, 318 audit entries.
> **Issues**: none.
> **Recent activity** (5):
> - `ses_a1b2c3d4` "jwt refresh rotation" - 31 obs - 2h ago - idle
> - `ses_e5f6g7h8` "rate limiter sliding window" - 12 obs - 5h ago - idle
> - `ses_i9j0k1l2` "schema migration" - 88 obs - 1d ago - completed
> - `ses_m3n4o5p6` "deploy fly.io" - 7 obs - 2d ago - completed
> - `ses_q7r8s9t0` "graph entity extraction" - 45 obs - 3d ago - completed

## 2. Stuck actions detected

User: "/health"

Diagnose response:

```json
{
  "server": "reachable",
  "llm": { "provider": "anthropic", "healthy": true },
  "embedding": { "provider": "local", "healthy": true },
  "counts": { "sessions": 12, "observations": 421, "memories": 38, "audit": 87 },
  "issues": { "actions": 3, "leases": 0, "sentinels": 0, "sketches": 0 }
}
```

Present:

> **Server**: reachable.
> **LLM**: anthropic - healthy.
> **Embedding**: local - healthy.
> **Counts**: 12 sessions, 421 observations, 38 memories, 87 audit entries.
> **Issues**: 3 stuck actions.
> **Recent activity**: ... (5 sessions)
>
> **Next**: run `memory_heal { categories: "actions" }` to release the stuck actions.

## 3. Server unreachable

User: "memory health"

`memory_diagnose` throws or returns null (daemon not running, wrong AGENTMEMORY_URL, network partition).

Do NOT proceed to `memory_sessions`. Present:

> **Server**: unreachable. No response from `http://localhost:3111` (or your configured `AGENTMEMORY_URL`).
>
> **Recovery**:
> - Local: `npx @agentmemory/agentmemory` in a separate terminal.
> - Remote: verify `AGENTMEMORY_URL` and that the daemon is up at that address.
> - Sandboxed: set `AGENTMEMORY_FORCE_PROXY=1` in your MCP env.
>
> Re-run /health once the server responds.

Do not invent a healthy report when the server is down.
