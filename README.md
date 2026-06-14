# DRAM

Durable Recall for Agent Memory.

A persistent memory layer for AI coding agents. DRAM gives agents a knowledge graph that survives context-window compaction, so they can pick up where they left off without re-deriving decisions or re-reading the codebase.

## The problem

AI agents hit a token limit during long sessions. The host summarizes older conversation to make room, and that summary is lossy — it drops the exact task wording, decisions made, and the reasoning behind them. The agent keeps working against a confused picture and breaks things.

DRAM fixes this with two pieces:

- An **MCP server** that maintains a knowledge graph of markdown files with typed relationships (depends_on, part_of, supersedes, relates_to). The agent checkpoints its working state as it goes, commits durable nodes when a task finishes, and retrieves the relevant subgraph when it starts a new task.
- **Hooks for Claude Code** that snapshot the full transcript before compaction fires and re-inject the working state afterward.

Markdown files are the source of truth. The SQLite index is derived and rebuildable. Nothing is ever hard-deleted — nodes are superseded or archived with the reason preserved.

## Install

### MCP server

```
cd server
npm install
npm run build
npm start
```

### Per-project (isolated memory)

Each project spawns its own DRAM process with a separate data directory. No port conflicts, no shared state between unrelated projects.

```json
{
  "mcpServers": {
    "dram": {
      "command": "node",
      "args": ["/absolute/path/to/server/dist/index.js", "--data-dir", "~/.dram/my-project"]
    }
  }
}
```

### Shared (cross-project memory)

Run one DRAM server in HTTP mode, connect multiple projects to it. Projects share the same knowledge graph.

Start the server:
```
DRAM_TRANSPORT=http node /path/to/server/dist/index.js
```

Then in each project's `.claude/mcp.json`:
```json
{
  "mcpServers": {
    "dram": {
      "type": "streamable-http",
      "url": "http://localhost:3577/mcp"
    }
  }
}
```

### Hooks (Claude Code)

1. Copy `pre-compact.sh` and `session-start.sh` into `.claude/hooks/` in your project.
2. Merge the `hooks` block from `settings.json` into your `.claude/settings.json`.
3. `chmod +x .claude/hooks/*.sh`
4. Restart Claude Code, run `/hooks` to confirm registration.

See [SETUP.md](SETUP.md) for details.

## MCP tools

| Tool | Purpose |
|---|---|
| `restore(session_id)` | Return current scratchpad for this session |
| `checkpoint(session_id, state)` | Save distilled working state |
| `commit_task(session_id, residue)` | Persist nodes to graph, run entity extraction and embedding, archive and clear scratchpad |
| `read_subgraph(task, budget?)` | Retrieve relevant graph neighborhood ranked by similarity, keywords, entity overlap, recency, and connectivity |
| `maintain()` | Run the maintenance handler: score importance, mark superseded nodes, demote stale leaves, repair edges, detect communities |

## HTTP API

| Route | Purpose |
|---|---|
| `POST /checkpoint` | Record a pre-compaction snapshot (called by hooks) |
| `GET /scratchpad?session_id=...` | Return scratchpad text (called by hooks) |
| `POST /maintain` | Run the maintenance handler |
| `GET /health` | Server status |

## Configuration

CLI flag: `--data-dir <path>` overrides the data directory (supports `~`). Takes precedence over the env var.

| Variable | Default | Description |
|---|---|---|
| `DRAM_DATA_DIR` | `~/.dram/` | Where nodes, scratchpads, and the index live |
| `DRAM_HTTP_PORT` | `3577` | HTTP API port (only used in `http` or `both` transport modes) |
| `DRAM_EMBEDDING_PROVIDER` | `ollama` | Embedding backend: `ollama` or `none` |
| `DRAM_OLLAMA_URL` | `http://localhost:11434` | Ollama API base URL |
| `DRAM_EMBEDDING_MODEL` | `nomic-embed-text` | Ollama model for embeddings |

## How it works

Each memory node is a markdown file with YAML frontmatter: id, type, status, timestamps, and typed edges (`depends_on`, `part_of`, `supersedes`, `relates_to`). SQLite indexes the nodes for search. If the index gets corrupted, `npm run rebuild-index` re-derives it from the markdown files on disk.

When a node is committed, DRAM extracts entities (code identifiers, file paths, technical terms) and claims (declarative sentences) from its content. Nodes that share entities automatically get derived edges connecting them — this catches relationships the agent forgot to link explicitly. If Ollama is running, node content is also embedded for semantic similarity search.

`read_subgraph` ranks candidates using multiple signals: embedding similarity, keyword matches, entity overlap with the query, recency, and in-degree (how many other nodes link to it). It seeds from the top matches, expands one hop along edges weighted by relationship type, and trims to a token budget.

Three memory tiers:

- **Durable** — the graph store (markdown + derived index), persists across all sessions
- **Scratchpad** — distilled working state for the current task, survives compaction within a session
- **Conversation** — volatile context window, never the system of record

The protocol the agent follows:

1. On start or resume — call `restore()`, re-establish task and decisions before acting
2. After each meaningful step — call `checkpoint()` with distilled state
3. On task completion — call `commit_task()` to persist what future tasks need, then the scratchpad is cleared

## Status

Phase 4 is implemented. The server supports three transport modes (`stdio`, `http`, `both`) with optional bearer-token authentication and localhost-only bind by default. Ready-to-paste protocol instructions ship for the Claude app (`protocols/claude-app.md`) and API (`protocols/claude-api.md`), and an example API client demonstrates the agentic loop with context editing.

An end-to-end eval suite (`npm test`) validates the definition-of-done criteria: compaction survival, reversibility (no hard deletes), retrieval precision, supersession chain preservation, enrichment pipeline, maintenance correctness, and index rebuild from markdown source of truth.

Still to come: thrash avoidance and archive-then-GC tuning.

## License

MIT
