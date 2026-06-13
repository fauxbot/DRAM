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

Starts an MCP interface on stdio and an HTTP API on port 3577.

Register it in your project's `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "dram": {
      "command": "node",
      "args": ["/absolute/path/to/server/dist/index.js"]
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
| `commit_task(session_id, residue)` | Persist nodes to graph, archive and clear scratchpad |
| `read_subgraph(task, budget?)` | Retrieve relevant graph neighborhood by keyword + edge expansion |

## HTTP API

| Route | Purpose |
|---|---|
| `POST /checkpoint` | Record a pre-compaction snapshot (called by hooks) |
| `GET /scratchpad?session_id=...` | Return scratchpad text (called by hooks) |
| `GET /health` | Server status |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DRAM_DATA_DIR` | `~/.dram/` | Where nodes, scratchpads, and the index live |
| `DRAM_HTTP_PORT` | `3577` | HTTP API port |

## How it works

Each memory node is a markdown file with YAML frontmatter: id, type, status, timestamps, and typed edges. SQLite indexes these for search. If the index gets corrupted, `npm run rebuild-index` re-derives it from the markdown files on disk.

Three memory tiers:

- **Durable** — the graph store (markdown + derived index), persists across all sessions
- **Scratchpad** — distilled working state for the current task, survives compaction within a session
- **Conversation** — volatile context window, never the system of record

The protocol the agent follows:

1. On start or resume — call `restore()`, re-establish task and decisions before acting
2. After each meaningful step — call `checkpoint()` with distilled state
3. On task completion — call `commit_task()` to persist what future tasks need, then the scratchpad is cleared

## Status

Phase 1 is implemented: MCP server skeleton with all four tools, HTTP API, markdown + SQLite storage, keyword-based subgraph retrieval with one-hop edge expansion.

Still to come: embedding-based semantic retrieval, entity/claim extraction, community summaries, maintenance/cleanup handler, multi-surface support (Claude app, API with context editing).

## License

MIT
