# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DRAM (Durable Recall for Agent Memory) — a persistent graph-memory layer for AI agents that survives context-window compaction. MCP server with seven tools, markdown-backed storage, entity/claim extraction, derived edges, optional embeddings via Ollama, multi-signal subgraph retrieval, graph maintenance, multi-project isolation with optional cross-project federation, and cross-surface support (stdio, remote HTTP, or both).

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
  - `project-manager.ts` — multi-project orchestration: registry, store cache, cross-project federation
  - `tools.ts` — MCP tool definitions with multi-signal ranking in read_subgraph
  - `http.ts` — HTTP routes, StreamableHTTP MCP transport, hook endpoints
  - `types.ts` — shared type definitions
  - `embeddings.ts` — pluggable embedding providers (Ollama, Noop)
  - `extraction.ts` — entity and claim extraction from node content
  - `rebuild-index.ts` — CLI to re-derive index and enrichments from markdown files
  - `auth.ts` — bearer token validation middleware
  - `transport.ts` — McpServer factory, transport mode detection
  - `maintenance.ts` — graph maintenance: importance scoring, demotion, community detection
- `protocols/` — ready-to-paste instructions for each surface
  - `claude-app.md` — Claude app Project instructions
  - `claude-api.md` — system prompt template + context-editing guidance for API users
- `examples/api-client.ts` — self-contained Claude API + DRAM agentic loop example
- `pre-compact.sh` — PreCompact hook for Claude Code
- `session-start.sh` — SessionStart hook for Claude Code
- `settings.json` — hook registration template
- `SETUP.md` — install guide for the hooks kit

## Design principles

1. Markdown files are source of truth; SQLite is a derived index, rebuildable.
2. Three tiers: durable graph, task scratchpad, volatile conversation. State never lives only in the volatile tier.
3. Store distilled state, not transcripts.
4. Never hard-delete — demote, supersede, or archive.
5. Projects are isolated by default; cross-project federation is opt-in.

## Multi-project architecture

Each project gets its own isolated store (nodes, index, scratchpads) under `~/.dram/projects/{project-id}/`. A `config.json` at the DRAM root tracks project metadata and links.

**Storage layout:**
```
~/.dram/
├── config.json              # Project registry
├── projects/
│   ├── my-app/              # Per-project store
│   │   ├── index.db
│   │   ├── nodes/
│   │   ├── scratchpads/
│   │   └── archive/scratchpads/
│   └── my-library/
│       └── ...
└── _default/                # Fallback when no project param is specified
```

**Modes:**
- `isolated` (default) — tools only see this project's graph
- `shared` — `read_subgraph` also searches linked projects (with a 0.6x cross-project score penalty)

**Tools:**
- All existing tools (`restore`, `checkpoint`, `commit_task`, `read_subgraph`, `maintain`) accept an optional `project` parameter
- `configure_project(project, mode?, link?, unlink?)` — set project mode and manage cross-project links
- `list_projects()` — list all registered projects with node counts and link status

**First-setup flow:** When a tool is called with a new project ID, the project is auto-created in isolated mode. The response includes a notice listing other available projects and suggesting `configure_project` for cross-project linking.

**Backward compatibility:** If no `project` parameter is ever used, everything routes to `_default` — identical to pre-0.5 behavior. Existing data at the DRAM root is auto-migrated to `projects/_default/` on first startup.

## Working-memory protocol (always in effect)

The DRAM MCP server is registered in `.claude/mcp.json`. Use its tools to
persist state across compaction boundaries.

All tools accept an optional `project` parameter. Pass it to scope
operations to a specific project (e.g., `project: "my-app"`). Omit it
to use the default project.

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
- `DRAM_EMBEDDING_PROVIDER` — `ollama` (default), `openai`, or `none`
- `DRAM_EMBEDDING_MODEL` — model name (default: `nomic-embed-text` for Ollama, `text-embedding-3-small` for OpenAI)
- `DRAM_OLLAMA_URL` — Ollama API URL (default `http://localhost:11434`)
- `DRAM_OPENAI_API_KEY` — OpenAI API key (falls back to `OPENAI_API_KEY`)
- `DRAM_EMBEDDING_URL` — base URL for OpenAI-compatible APIs (default `https://api.openai.com/v1`)
- `DRAM_TRANSPORT` — transport mode: `stdio` (default), `http` (remote only), `both` (stdio + HTTP MCP)
- `DRAM_AUTH_TOKEN` — if set, all HTTP requests require `Authorization: Bearer <token>`
- `DRAM_HTTP_HOST` — bind address (default `127.0.0.1`; set to `0.0.0.0` for remote access)
- `DRAM_TLS` — TLS mode: `off` (default), `auto` (self-signed), `custom` (user-provided certs)
- `DRAM_TLS_CERT` — path to PEM certificate file (required when `DRAM_TLS=custom`)
- `DRAM_TLS_KEY` — path to PEM private key file (required when `DRAM_TLS=custom`)
- `DRAM_TLS_DIR` — directory for auto-generated certificates (default `~/.dram/certs/`)
- `DRAM_PROJECTS_ALLOW` — comma-separated project IDs to expose (default: all projects)
- `DRAM_CORS_ORIGINS` — comma-separated allowed origins, or `*` for all (default: none)

## Security

DRAM supports three TLS configurations:

1. **No TLS** (`DRAM_TLS=off`, default) — plain HTTP, suitable for localhost or behind a reverse proxy.
2. **Auto TLS** (`DRAM_TLS=auto`) — generates a self-signed certificate on first run, cached in `~/.dram/certs/`. Auto-regenerates when the certificate is within 30 days of expiry. Good for development, internal networks, and testing.
3. **Custom TLS** (`DRAM_TLS=custom`) — uses your own certificate and key (set `DRAM_TLS_CERT` and `DRAM_TLS_KEY`). Use this with certificates from Let's Encrypt, your internal CA, or any other provider.

For production deployments, either use `DRAM_TLS=custom` with proper certificates or place a TLS-terminating reverse proxy (nginx, Caddy, cloud load balancer) in front of the server with `DRAM_TLS=off`.

The server binds to localhost by default. When binding to all interfaces (`DRAM_HTTP_HOST=0.0.0.0`), the server warns if auth or TLS is not configured.

## Hosted deployment

DRAM can run as a hosted MCP server accessible to remote clients. A typical hosted setup:

```bash
# Serve all projects over HTTPS with auth
DRAM_TRANSPORT=http \
DRAM_HTTP_HOST=0.0.0.0 \
DRAM_TLS=auto \
DRAM_AUTH_TOKEN=your-secret-token \
DRAM_CORS_ORIGINS=* \
npm start

# Serve a single project with custom certs
DRAM_TRANSPORT=http \
DRAM_HTTP_HOST=0.0.0.0 \
DRAM_TLS=custom \
DRAM_TLS_CERT=/etc/dram/cert.pem \
DRAM_TLS_KEY=/etc/dram/key.pem \
DRAM_AUTH_TOKEN=your-secret-token \
DRAM_PROJECTS_ALLOW=my-app \
npm start
```

**Project scoping:** Set `DRAM_PROJECTS_ALLOW` to a comma-separated list of project IDs to restrict which projects this instance serves. Requests for unlisted projects receive a 403. When omitted, all projects are accessible (suitable for a personal hosted instance). This applies to both HTTP and MCP transports.

**CORS:** Set `DRAM_CORS_ORIGINS` for browser-based MCP clients. Use `*` to allow all origins, or a comma-separated list of specific origins (e.g., `https://app.example.com,https://claude.ai`).
