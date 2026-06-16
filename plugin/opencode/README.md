<h1 align="center">
  <img src="https://github.com/opencode-ai.png?size=80" alt="OpenCode" width="28" height="28" align="center" />
  &nbsp;agentmemory for OpenCode
</h1>

<p align="center">
  <strong>Your OpenCode agents remember everything. No more re-explaining.</strong><br/>
  <sub>Persistent cross-session memory via <a href="https://github.com/rohitg00/agentmemory">agentmemory</a> - 95.2% retrieval accuracy on <a href="https://arxiv.org/abs/2410.10813">LongMemEval-S</a>.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-54_tools-1f6feb?style=flat-square" alt="54 MCP tools" />
  <img src="https://img.shields.io/badge/Plugin-34_hooks-1f6feb?style=flat-square" alt="34 hooks" />
  <img src="https://img.shields.io/badge/Skills-16-1f6feb?style=flat-square" alt="16 skills" />
  <img src="https://img.shields.io/badge/R@5-95.2%25-00875f?style=flat-square" alt="95.2% R@5" />
</p>

---

## Quick start

### 1. Start the agentmemory server

```bash
npx @agentmemory/agentmemory
```

The server starts on `http://localhost:3111`.

### 2. One-shot install (recommended)

```bash
agentmemory connect opencode --with-plugin
```

`--with-plugin` writes the MCP block to `~/.config/opencode/opencode.json`, copies the auto-capture plugin to `~/.config/opencode/plugins/agentmemory-capture.ts`, copies 16 skills (9 invocable + 7 reference) to `~/.config/opencode/skills/<name>/`, and adds `"plugin": ["./plugins/agentmemory-capture.ts"]` to `opencode.json`. The merge is idempotent and backs up any existing files first. OpenCode merges skills into its unified slash command palette (`source: "skill"`), so `/recall`, `/remember`, `/health` work directly from the palette.

Without `--with-plugin`, `agentmemory connect opencode` writes the MCP block only, leaving the plugin install to you.

### 3. Manual install (alternative)

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "agentmemory": {
      "type": "local",
      "command": ["npx", "-y", "@agentmemory/mcp"],
      "enabled": true
    }
  },
  "plugin": ["./plugins/agentmemory-capture.ts"]
}
```

Copy the bundled files:

```bash
mkdir -p ~/.config/opencode/plugins ~/.config/opencode/skills
cp plugin/opencode/agentmemory-capture.ts ~/.config/opencode/plugins/
cp -R plugin/skills/* ~/.config/opencode/skills/
```

Restart OpenCode or open a new session. The plugin auto-captures session lifecycle, messages, tool execution, file edits, permissions, todos, and config events.

## What gets captured

### Session lifecycle

| Event | Hook | agentmemory API |
|---|---|---|
| Session start | `session.created` | POST /session/start |
| Idle | `session.idle` + `session.status` (idle) | POST /session/checkpoint |
| Status transitions | `session.status` (idle/busy/retry) | POST /observe |
| Compaction | `session.compacted` | POST /session/checkpoint + POST /observe |
| Metadata updates / resume | `session.updated` | POST /observe; first sighting of a sid without a prior session.created treats it as a resume - re-fires POST /session/start to repopulate context cache and clear context-injected flag |
| Code change tracking | `session.diff` | POST /observe |
| Session delete | `session.deleted` | POST /session/end + /crystals/auto + /consolidate-pipeline |
| Session error | `session.error` | POST /observe |

### Messages and prompts

| Event | Hook | agentmemory API |
|---|---|---|
| User prompt (rich) | `chat.message` | POST /observe |
| User message metadata | `message.updated` (user) | POST /observe |
| Assistant response | `message.updated` (assistant) | POST /observe |
| Transcript transforms | `experimental.chat.messages.transform` | POST /observe |
| Message removed (undo) | `message.removed` | POST /observe |
| Message part removed | `message.part.removed` | POST /observe |

### Parts and steps

| Event | Hook | agentmemory API |
|---|---|---|
| Subagent start | `message.part.updated` (subtask) | POST /observe |
| Tool completed (early signal) | `tool.execute.after` | POST /observe (deduped against message.part.updated) |
| Tool completed (state lag path) | `message.part.updated` (tool completed) | POST /observe (dedup via shared `seenToolCallIds`) |
| Tool error | `message.part.updated` (tool error) | POST /observe |
| Step finish (cost/tokens) | `message.part.updated` (step-finish) | POST /observe |
| Reasoning trace | `message.part.updated` (reasoning) | POST /observe |
| Patch applied | `message.part.updated` (patch) | POST /observe |
| Auto/manual compaction | `message.part.updated` (compaction) | POST /observe |
| Agent selection | `message.part.updated` (agent) | POST /observe |
| API retry | `message.part.updated` (retry) | POST /observe |

### File enrichment pipeline

| Event | Hook | agentmemory API |
|---|---|---|
| File tool params | `tool.execute.before` -> stash paths | - |
| File edited | `file.edited` -> stash paths | - |
| External file watcher event | `file.watcher.updated` | POST /observe (add/change/unlink) |
| File part attached | `message.part.updated` (file) -> stash paths | - |
| Enrichment inject | `experimental.chat.system.transform` | POST /enrich -> `output.system[]` |
| Memory context inject | `experimental.chat.system.transform` | POST /context -> `output.system[]` |

### Permissions

| Event | Hook | agentmemory API |
|---|---|---|
| Permission ask (v1 bus) | `permission.asked` | POST /observe (id, permission, patterns, always, tool.callID, metadata) |
| Permission ask (v2 bus) | `permission.v2.asked` | POST /observe (id, action, resources, save, metadata) |
| Permission state changed | `permission.updated` | POST /observe |
| Permission reply (v1) | `permission.replied` | POST /observe |
| Permission reply (v2) | `permission.v2.replied` | POST /observe (requestID, reply) |

### Tasks and commands

| Event | Hook | agentmemory API |
|---|---|---|
| Task tracking (w/ priority) | `todo.updated` | POST /observe |
| Command (pre-execute) | `command.execute.before` | POST /observe |
| Command (executed) | `command.executed` | POST /observe |
| Git branch switch | `vcs.branch.updated` | POST /observe (current branch) |

### Model and config

| Event | Hook | agentmemory API |
|---|---|---|
| LLM parameters | `chat.params` | POST /observe |
| Config loaded | `config` | POST /observe |
| Compaction (WIP upstream) | `experimental.session.compacting` | POST /context -> `output.context[]` |
| Plugin reload | `dispose` | fires fire-and-forget POST /session/checkpoint for the active session if any, then clears all session-scoped maps in-process. Does NOT post /session/end - the OpenCode session is still alive |

### File enrichment + memory injection (two-layer pipeline)

`experimental.chat.system.transform` fires before every LLM call and injects two layers of context:

1. **Memory context** (once per session): calls `/agentmemory/context` and injects project profile, recent session summaries, and important past observations into the system prompt. Equivalent to Claude's MEMORY.md bridge - instead of syncing to a markdown file, context is injected directly. **Resumed sessions** (when `session.updated` arrives without a prior `session.created` in this plugin process) re-trigger this injection automatically.

2. **File enrichment** (every turn with stashed files): calls `/agentmemory/enrich` with files stashed by `tool.execute.before`, `file.edited`, and `message.part.updated` (file parts). File-specific context (past observations, related bugs, semantic search) is injected into the system prompt.

```text
System prompt = [OpenCode instructions] + [memory context] + [file enrichment] + [user message]
                                        ^                 ^
                               first turn or resume   every file-touching turn
```

## Reliability

The plugin is built to survive busy sessions, slow networks, and unattended shutdowns.

### Server-side deduplication

`/session/checkpoint` is idempotent on the server. When there is no new activity since `lastCheckpointAt`, the server returns `{ noOp: true }` and skips consolidation. The plugin posts unconditionally on idle, compaction, and dispose, and the server remains the source of truth for deduplication.

### HTTPS guard

If `AGENTMEMORY_SECRET` is set and `AGENTMEMORY_URL` points to plaintext `http://` against a non-loopback host, the plugin logs a one-time warning at init pointing you at HTTPS or an SSH tunnel. It does not refuse the request - the warning is the contract.

### Health probe (DEBUG only)

When `OPENCODE_AGENTMEMORY_DEBUG=1` the plugin fires a single `GET /agentmemory/health` at init and prints the status code to stderr. Useful for catching DNS / route / bearer-token failures before the first observation lands.

### Tool output sanitization

`post_tool_use` and `post_tool_failure` observations route the tool output through `sanitizeOutput()` before truncation. Strings longer than 100 chars matching common base64 image / blob prefixes (`data:image/`, `iVBORw0KGgo`, `/9j/`, etc.) are replaced with `<base64:stripped:Nb>` markers. Saves storage and prevents large screenshots from polluting recall results.

### Dispose cleanup

The `dispose` hook fires when OpenCode unloads the plugin (hot reload, host shutdown). It does NOT post `/session/end` - plugin teardown is not session termination, and the OpenCode session may still be alive in the host. `dispose` only clears every module-level map (`stashedFiles`, `seenSubtaskIds`, `seenToolCallIds`, `contextInjectedSessions`, `startContextCache`, `lastSummarizeAt`) and resets `activeSessionId` so a re-instantiated plugin starts clean.

Abandoned-session consolidation runs only on `session.deleted` (`/session/end` + `/crystals/auto` + `/consolidate-pipeline`). If a session is closed without an explicit delete in the OpenCode UI, the server-side `session-sweep` cron handles late finalization.

### Configurable timeouts

| Env var | Default | Applies to |
|---|---|---|
| `OPENCODE_AGENTMEMORY_TIMEOUT_MS` | `5000` | `/observe`, `/context`, `/enrich`, `/summarize`, `/session/start`, `/session/end` |
| `OPENCODE_AGENTMEMORY_HEAVY_TIMEOUT_MS` | `30000` | `/crystals/auto` and `/consolidate-pipeline` fan-out on `session.deleted` |
| `OPENCODE_AGENTMEMORY_DEBUG` | unset | when `=1`, log POST failures + fire the init health probe |
| `AGENTMEMORY_URL` | `http://localhost:3111` | inherited from shell; agentmemory server base URL |
| `AGENTMEMORY_SECRET` | unset | inherited from shell; bearer token for protected deployments |

## MEMORY.md vs AGENTS.md: how context flows

Claude Code and OpenCode take fundamentally different approaches to injecting memory context into the agent's system prompt.

### Claude Code: file-backed bridge (two-hop)

```
agentmemory  --write-->  MEMORY.md  --read-->  Claude system prompt
```

- The `claude-bridge/sync` endpoint serializes agentmemory observations into a `MEMORY.md` file in the project root
- Claude Code reads `MEMORY.md` on session start and prepends it to the system prompt
- Sync is periodic - sessions only get fresh context when the bridge last ran (session end, pre-compact)
- Memory data lives in a git-trackable file, visible to CI, team members, and other tools

### OpenCode: direct injection (one-hop)

```
agentmemory  --push-->  OpenCode system prompt
```

- `experimental.chat.system.transform` calls `/context` at runtime and pushes the response directly into `output.system[]`
- Always current - context is fetched at session start (once) and before file-touching turns (per-batch). Resumed sessions re-fetch automatically.
- No file intermediary - no stale copies, no merge conflicts, no disk I/O
- `AGENTS.md` is a static instruction file for project conventions, coding standards, and tool guidance - agentmemory does not read or write it

### Tradeoffs

| Dimension | Claude (MEMORY.md bridge) | OpenCode (direct injection) |
|---|---|---|
| Freshness | Stale between syncs | Always current (fetched at call time) |
| Visibility | Human-readable file in repo | In-memory injection only |
| Simplicity | Two moving parts (bridge + file) | One step (API -> system prompt) |
| Team sharing | File is git-trackable, CI-friendly | Memory shared via agentmemory server API |
| Integration | Any tool can read MEMORY.md | Requires OpenCode plugin SDK |

### Why OpenCode goes direct

agentmemory already persists everything in SQLite (`data/state_store.db`). Adding an intermediate MEMORY.md file would duplicate data, introduce sync lag, and require the model to re-parse structured context from markdown. Direct injection delivers the same data with lower latency and zero staleness - the agent always sees what agentmemory knows right now.

## Skills

Sixteen skills land at `~/.config/opencode/skills/<name>/SKILL.md`. OpenCode's command registry merges them into the unified slash command palette as `source: "skill"`, so the 9 invocable ones appear as slash commands AND are also loadable by the agent via the native `skill` tool based on description matching.

**Invocable (9)**:
- `/recall <query>` - Search past observations and lessons (hybrid BM25 + vector + graph).
- `/remember <text>` - Save an insight to long-term memory with searchable concept tags.
- `/health` - Probe the server, list providers + counts, surface stuck items, suggest `memory_heal`.
- `/recap <window>` - Roll up recent sessions for the current project, grouped by date.
- `/handoff [cwd]` - Resume the most recent session for the working directory, leading with any unanswered question.
- `/forget <query>` - Show matches, get explicit yes, then `memory_governance_delete` the chosen memory ids.
- `/commit-context <ref>` - Trace a file/function/line back to the agent session that produced its current commit.
- `/commit-history [filters]` - List recent agent-linked commits, optionally filtered by branch or repo.
- `/session-history` - Show what happened in recent sessions on this project as a clean timeline.

**Reference (7, loaded on demand by the agent)**:
- `agentmemory-mcp-tools` - Map of every MCP tool, what it does, parameters.
- `agentmemory-rest-api` - HTTP REST endpoint surface.
- `agentmemory-config` - Env vars, ports, feature flags.
- `agentmemory-agents` - How `agentmemory connect` wires each host.
- `agentmemory-hooks` - Plugin hooks that auto-capture observations.
- `agentmemory-architecture` - iii engine primitives, storage model, viewer.
- `write-agentmemory-skill` - House format for authoring new skills.

## Session instruction injection

Agentmemory usage instructions are injected into the system prompt on the first turn of every session via `experimental.chat.system.transform` (alongside memory context from `/context`). This is functionally equivalent to Claude Code's skills mechanism - the agent learns which `agentmemory_memory_*` tools to use and when, without needing separate skill invocations.

## What's not covered

| Upstream surface | Status |
|---|---|
| `permission.ask` typed hook | Declared in `@opencode-ai/plugin@1.17.7` types but the runtime never invokes it (regression from the Effect refactor, tracked in [opencode-ai/opencode#28066](https://github.com/anomalyco/opencode/issues/28066) / [#7006](https://github.com/anomalyco/opencode/issues/7006)). We capture the equivalent lifecycle via the `permission.asked` bus event instead. |
| `experimental.session.compacting` | Still experimental upstream. The plugin handles it - if the Go binary wires the dispatch it takes effect automatically. |
| `SubagentStop` / `task.completed` / `subtask.completed` | OpenCode's `SubtaskPart` type still has no completion / result fields ([packages/core SubtaskPart](https://github.com/anomalyco/opencode/blob/main/packages/core/src/v1/session.ts)). Closest signal is `session.idle`, already covered. |
| Claude `MEMORY.md` bridge | OpenCode-specific - OpenCode uses its own `AGENTS.md` mechanism, not Claude's `MEMORY.md`. |
| `shell.env`, `chat.headers`, `tool.definition`, `experimental.text.complete`, `experimental.provider.small_model`, `experimental.compaction.autocontinue` typed hooks | Lower-signal hooks; not wired. Open an issue if a use case appears. |
| `installation.*`, `lsp.*`, `tui.*` bus events | Lower-signal bus events; not wired. Open an issue if a use case appears. |
