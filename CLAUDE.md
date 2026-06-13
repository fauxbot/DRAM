# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DRAM (Durable Recall for Agent Memory) — a persistent graph-memory layer for AI agents that survives context-window compaction. Through Phase 2: MCP server with four tools + two HTTP routes, entity/claim extraction, derived edges, optional embeddings via Ollama, and multi-signal subgraph retrieval.

## Build and run

```bash
cd server
npm install
npm run build
npm start            # MCP on stdio, HTTP on port 3577
npm run rebuild-index  # re-derive SQLite from markdown files
```

## Project layout

- `server/src/` — MCP memory server (TypeScript)
  - `index.ts` — entry point, starts MCP + HTTP
  - `store.ts` — storage layer: scratchpads, markdown nodes, SQLite index, enrichment pipeline
  - `tools.ts` — MCP tool definitions with multi-signal ranking in read_subgraph
  - `http.ts` — HTTP routes for hook access
  - `types.ts` — shared type definitions
  - `embeddings.ts` — pluggable embedding providers (Ollama, Noop)
  - `extraction.ts` — entity and claim extraction from node content
  - `rebuild-index.ts` — CLI to re-derive index and enrichments from markdown files
- `pre-compact.sh` — PreCompact hook for Claude Code
- `session-start.sh` — SessionStart hook for Claude Code
- `settings.json` — hook registration template
- `SETUP.md` — install guide for the hooks kit

## Design principles

1. Markdown files are source of truth; SQLite is a derived index, rebuildable.
2. Three tiers: durable graph, task scratchpad, volatile conversation. State never lives only in the volatile tier.
3. Store distilled state, not transcripts.
4. Never hard-delete — demote, supersede, or archive.

## Working-memory protocol (always in effect)

The DRAM MCP server is registered in `.claude/mcp.json`. Use its tools to
persist state across compaction boundaries.

1. **On start or resume** — call `restore(session_id)` first. Read
   `.claude/state/scratchpad.md` as a fallback. Re-establish the task,
   decisions already made, and current step before acting. Never re-plan
   or re-derive something already recorded.

2. **After each meaningful step** — call `checkpoint(session_id, state)`
   with distilled state: the task as stated, decisions and why, current
   progress, open questions, and hard constraints. Also update
   `.claude/state/scratchpad.md` as a local backup. Keep it small enough
   to reload in full. Overwrite current-state in place; for decisions,
   append and mark anything reversed as superseded.

3. **On task completion** — call `commit_task(session_id, residue)` to
   persist what future tasks will need into the graph, then the scratchpad
   is archived and cleared automatically.

Use `read_subgraph(task)` at the start of a new task to load relevant
context from the graph before beginning work.

If you are ever unsure of the current state, stop and call `restore()`
before continuing. Re-reading is cheap; acting on stale context is not.

## Environment variables

- `DRAM_DATA_DIR` — data directory (default `~/.dram/`)
- `DRAM_HTTP_PORT` — HTTP port (default `3577`)
- `DRAM_EMBEDDING_PROVIDER` — `ollama` (default) or `none`
- `DRAM_OLLAMA_URL` — Ollama API URL (default `http://localhost:11434`)
- `DRAM_EMBEDDING_MODEL` — embedding model (default `nomic-embed-text`)
