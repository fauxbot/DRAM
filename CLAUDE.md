# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DRAM (Durable Recall for Agent Memory) — a persistent graph-memory layer for AI agents that survives context-window compaction. Phase 1 is implemented: MCP server skeleton with four tools + two HTTP routes, backed by markdown files and SQLite.

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
  - `store.ts` — storage layer: scratchpads, markdown nodes, SQLite index
  - `tools.ts` — MCP tool definitions (restore, checkpoint, commit_task, read_subgraph)
  - `http.ts` — HTTP routes for hook access
  - `types.ts` — shared type definitions
  - `rebuild-index.ts` — CLI to re-derive index from markdown files
- `pre-compact.sh` — PreCompact hook for Claude Code
- `session-start.sh` — SessionStart hook for Claude Code
- `settings.json` — hook registration template
- `SETUP.md` — install guide for the hooks kit

## Design principles

1. Markdown files are source of truth; SQLite is a derived index, rebuildable.
2. Three tiers: durable graph, task scratchpad, volatile conversation. State never lives only in the volatile tier.
3. Store distilled state, not transcripts.
4. Never hard-delete — demote, supersede, or archive.

## Environment variables

- `DRAM_DATA_DIR` — data directory (default `~/.dram/`)
- `DRAM_HTTP_PORT` — HTTP port (default `3577`)
