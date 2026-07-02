# DRAM

Durable Recall for Agent Memory.

A persistent memory layer for AI coding agents. DRAM gives agents a knowledge graph that survives context-window compaction, so they can pick up where they left off without re-deriving decisions or re-reading the codebase.

## The problem

AI agents hit a token limit during long sessions. The host summarizes older conversation to make room, and that summary is lossy — it drops the exact task wording, decisions made, and the reasoning behind them. The agent keeps working against a confused picture and breaks things.

DRAM fixes this with two pieces:

- An **MCP server** that maintains a knowledge graph of markdown files with typed relationships (depends_on, part_of, supersedes, relates_to). The agent checkpoints its working state as it goes, commits durable nodes when a task finishes, and retrieves the relevant subgraph when it starts a new task.
- **Hooks for Claude Code** that snapshot the full transcript before compaction fires and re-inject the working state afterward.

Markdown files are the source of truth. The SQLite index is derived and rebuildable. Nothing is ever hard-deleted — nodes are superseded or archived with the reason preserved.

---

## Quick start

```bash
cd server
npm install
npm run build
npm start
```

That starts DRAM on stdio (for direct MCP client connections). For a full HTTP server:

```bash
DRAM_TRANSPORT=http npm start
# => listening on http://127.0.0.1:3577
```

---

## Table of contents

- [Server modes](#server-modes)
- [Running locally](#running-locally)
- [Running as a hosted server](#running-as-a-hosted-server)
- [TLS and encryption](#tls-and-encryption)
- [Authentication](#authentication)
- [Project management](#project-management)
- [Client setup](#client-setup)
- [MCP tools](#mcp-tools)
- [HTTP API](#http-api)
- [Hooks (Claude Code)](#hooks-claude-code)
- [Environment variables](#environment-variables)
- [Architecture](#architecture)

---

## Server modes

DRAM supports three transport modes controlled by `DRAM_TRANSPORT`:

| Mode | Value | What it does |
|------|-------|-------------|
| **stdio** | `stdio` (default) | MCP over stdin/stdout. One client connects directly. No HTTP server starts. |
| **HTTP** | `http` | HTTP server only. Serves the REST API and MCP-over-HTTP (StreamableHTTP). Multiple clients can connect simultaneously. |
| **Both** | `both` | Starts both stdio MCP and the HTTP server. Useful when you want a local Claude Code session on stdio and also expose the HTTP API for hooks or remote clients. |

---

## Running locally

### Stdio mode (simplest)

Stdio is the default. Point your MCP client directly at the server binary:

```bash
cd server
npm install && npm run build
npm start
```

The server reads from stdin and writes to stdout. Configure your client to launch it as a subprocess (see [Client setup](#client-setup)).

### Local HTTP server

Run DRAM as an HTTP server on localhost:

```bash
DRAM_TRANSPORT=http npm start
# => dram: listening on http://127.0.0.1:3577 (MCP + HTTP API)
```

This binds to `127.0.0.1` only — not accessible from other machines. You can now:

- Hit the REST API at `http://localhost:3577/health`
- Connect MCP clients to `http://localhost:3577/mcp`
- Use the hooks to sync state via HTTP

Change the port with `DRAM_HTTP_PORT`:

```bash
DRAM_HTTP_PORT=4000 DRAM_TRANSPORT=http npm start
```

### Both transports

Run stdio and HTTP simultaneously:

```bash
DRAM_TRANSPORT=both npm start
```

This is useful when Claude Code connects over stdio for the primary MCP session, while hooks use the HTTP API to sync snapshots.

### With Ollama embeddings

DRAM uses Ollama for semantic embeddings by default. If Ollama is running locally:

```bash
# Pull the embedding model (one-time)
ollama pull nomic-embed-text

# DRAM will auto-detect Ollama at http://localhost:11434
npm start
```

Without Ollama, DRAM falls back to keyword-only retrieval:

```bash
DRAM_EMBEDDING_PROVIDER=none npm start
```

### Custom data directory

By default, data lives in `~/.dram/`. Override with:

```bash
DRAM_DATA_DIR=~/my-project-memory npm start
# or
npm start -- --data-dir ~/my-project-memory
```

---

## Running as a hosted server

DRAM can run on a remote machine and serve one or more projects over HTTPS to any number of clients.

### Basic hosted setup

```bash
DRAM_TRANSPORT=http \
DRAM_HTTP_HOST=0.0.0.0 \
DRAM_TLS=auto \
DRAM_AUTH_TOKEN=$(openssl rand -hex 32) \
DRAM_CORS_ORIGINS=* \
npm start
```

This:
- Binds to all interfaces (`0.0.0.0`)
- Auto-generates a self-signed TLS certificate
- Requires bearer-token authentication on every request
- Allows CORS from any origin (for browser-based MCP clients)

### Single-project server

Restrict the server to serve only one project:

```bash
DRAM_TRANSPORT=http \
DRAM_HTTP_HOST=0.0.0.0 \
DRAM_TLS=auto \
DRAM_AUTH_TOKEN=my-secret \
DRAM_PROJECTS_ALLOW=my-app \
npm start
```

Requests for any project other than `my-app` will receive a `403 Forbidden`.

### Multi-project server with allowlist

Serve a curated set of projects:

```bash
DRAM_PROJECTS_ALLOW=frontend,backend,shared-lib \
DRAM_TRANSPORT=http \
DRAM_HTTP_HOST=0.0.0.0 \
DRAM_TLS=auto \
DRAM_AUTH_TOKEN=my-secret \
npm start
```

Only `frontend`, `backend`, and `shared-lib` are accessible. New projects cannot be auto-created outside this list.

### Production deployment with custom certs

For production, use proper certificates (Let's Encrypt, internal CA, etc.):

```bash
DRAM_TRANSPORT=http \
DRAM_HTTP_HOST=0.0.0.0 \
DRAM_TLS=custom \
DRAM_TLS_CERT=/etc/dram/fullchain.pem \
DRAM_TLS_KEY=/etc/dram/privkey.pem \
DRAM_AUTH_TOKEN=my-secret \
npm start
```

### Behind a reverse proxy

If you already have nginx, Caddy, or a cloud load balancer handling TLS:

```bash
DRAM_TRANSPORT=http \
DRAM_HTTP_HOST=127.0.0.1 \
DRAM_AUTH_TOKEN=my-secret \
npm start
```

Leave `DRAM_TLS=off` (the default) and let the proxy terminate TLS. Example nginx config:

```nginx
server {
    listen 443 ssl;
    server_name dram.example.com;

    ssl_certificate     /etc/letsencrypt/live/dram.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dram.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3577;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE support for MCP streaming
        proxy_buffering off;
        proxy_cache off;
    }
}
```

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY server/ .
RUN npm ci && npm run build

ENV DRAM_TRANSPORT=http
ENV DRAM_HTTP_HOST=0.0.0.0
ENV DRAM_TLS=auto
ENV DRAM_EMBEDDING_PROVIDER=none
EXPOSE 3577

CMD ["node", "dist/index.js"]
```

```bash
docker build -t dram .
docker run -d \
  -p 3577:3577 \
  -v dram-data:/root/.dram \
  -e DRAM_AUTH_TOKEN=my-secret \
  dram
```

### Startup warnings

The server warns at startup when it detects potentially insecure configurations:

- Binding to all interfaces (`0.0.0.0`) without `DRAM_AUTH_TOKEN` set
- Binding to all interfaces without TLS enabled

These are warnings, not errors — the server still starts. They are meant to catch accidental exposure.

---

## TLS and encryption

### Off (default)

```bash
DRAM_TLS=off  # or simply omit it
```

Plain HTTP. Use this for localhost-only deployments or when TLS is handled by a reverse proxy.

### Auto (self-signed)

```bash
DRAM_TLS=auto
```

On first startup, DRAM generates a 2048-bit RSA self-signed certificate with SANs for `localhost`, `127.0.0.1`, and `::1`. The certificate and private key are cached in `~/.dram/certs/` (override with `DRAM_TLS_DIR`).

The certificate is valid for 365 days. DRAM checks the expiry on each startup and auto-regenerates when the certificate is within 30 days of expiry.

This is suitable for:
- Development and testing
- Internal networks where you can trust the self-signed cert
- Docker containers where you just need encryption in transit

Clients connecting to a self-signed server need to either trust the certificate or disable certificate verification. For example:

```bash
# curl with self-signed cert
curl --cacert ~/.dram/certs/cert.pem https://localhost:3577/health

# Or skip verification (development only)
curl -k https://localhost:3577/health
```

```javascript
// Node.js client with self-signed cert
const agent = new https.Agent({
  ca: fs.readFileSync(path.join(os.homedir(), '.dram/certs/cert.pem'))
});
```

### Custom certificates

```bash
DRAM_TLS=custom
DRAM_TLS_CERT=/path/to/cert.pem    # Full chain recommended
DRAM_TLS_KEY=/path/to/key.pem
```

Use this with certificates from:
- **Let's Encrypt** — free, automated, widely trusted
- **Internal CA** — corporate/organizational certificates
- **Commercial CA** — DigiCert, Sectigo, etc.

The server reads the cert and key files at startup. To rotate certificates, replace the files and restart the server.

---

## Authentication

Set `DRAM_AUTH_TOKEN` to require bearer-token authentication on all HTTP requests:

```bash
DRAM_AUTH_TOKEN=my-secret-token
```

Clients must include the token in every request:

```bash
curl -H "Authorization: Bearer my-secret-token" https://localhost:3577/health
```

When connecting MCP clients over HTTP, include the token in the client configuration (see [Client setup](#client-setup)).

Auth applies to the HTTP transport only. The stdio transport relies on process-level access control (only the parent process can read/write stdio).

Token comparison uses timing-safe equality to prevent timing attacks.

Generate a strong token:

```bash
# Linux/macOS
openssl rand -hex 32

# PowerShell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

---

## Project management

### Isolation (default)

Each project gets its own store under `~/.dram/projects/{project-id}/`. Projects are created automatically when first referenced:

```
~/.dram/
├── config.json
├── certs/                   # Auto-generated TLS certs
└── projects/
    ├── _default/            # Used when no project is specified
    ├── my-app/
    │   ├── index.db
    │   ├── nodes/
    │   ├── scratchpads/
    │   └── archive/
    └── my-library/
        └── ...
```

### Cross-project federation

Link projects so `read_subgraph` searches across them (with a 0.6x score penalty for cross-project results):

```
# Via MCP tool
configure_project(project: "my-app", mode: "shared", link: ["my-library"])
```

Both projects are updated bidirectionally.

### Project allowlist

For hosted deployments, restrict which projects are accessible:

```bash
DRAM_PROJECTS_ALLOW=frontend,backend,shared-lib
```

- Only listed projects can be accessed or created
- Requests for unlisted projects return 403
- `list_projects` only shows allowed projects
- Applies to both HTTP and MCP transports
- Omit to allow all projects (default)

---

## Client setup

### Claude Code (VS Code extension)

Create `.mcp.json` in the project root for stdio:

```json
{
  "mcpServers": {
    "dram": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server/dist/index.js"]
    }
  }
}
```

For Claude Code CLI, use `.claude/mcp.json` instead.

To connect to a hosted DRAM server over HTTP:

```json
{
  "mcpServers": {
    "dram": {
      "type": "streamable-http",
      "url": "https://dram.example.com:3577/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

### OpenAI Codex

Add to `.codex/config.toml` in the project root (or `~/.codex/config.toml` for global):

```toml
[mcp_servers.dram]
command = "node"
args = ["/absolute/path/to/server/dist/index.js"]
env = { "DRAM_TRANSPORT" = "stdio" }
startup_timeout_sec = 15
```

Copy the memory protocol from [protocols/codex.md](protocols/codex.md) into your project's `AGENTS.md`.

### Generic MCP client (HTTP)

Any MCP client that supports StreamableHTTP can connect:

```
Endpoint:  https://your-host:3577/mcp
Method:    POST (JSON-RPC 2.0)
Headers:   Authorization: Bearer <token>
           Content-Type: application/json
Session:   Mcp-Session-Id header (returned on initialize)
```

### Claude API (programmatic)

See [examples/api-client.ts](examples/api-client.ts) for a self-contained agentic loop that uses DRAM over HTTP, and [protocols/claude-api.md](protocols/claude-api.md) for system-prompt guidance.

---

## MCP tools

| Tool | Purpose |
|------|---------|
| `restore(session_id, project?)` | Return the current scratchpad for this session. Call on start or resume before any other action. |
| `checkpoint(session_id, state, project?)` | Save distilled working state (task, decisions, progress, open questions). |
| `commit_task(session_id, residue, project?)` | Persist nodes to the graph, run entity extraction and embedding, archive and clear the scratchpad. |
| `read_subgraph(task, budget?, project?)` | Retrieve relevant graph neighborhood ranked by similarity, keywords, entity overlap, recency, and connectivity. |
| `maintain(project?)` | Run the maintenance handler: score importance, mark superseded nodes, demote stale leaves, repair edges, detect communities. |
| `configure_project(project, mode?, link?, unlink?)` | Set project isolation mode and manage cross-project links. |
| `list_projects()` | List all registered projects with node counts and link status. |

All tools accept an optional `project` parameter. Omit it to use the default project.

---

## HTTP API

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/checkpoint` | Record a pre-compaction snapshot (called by hooks). Body: `{session_id, reason?, snapshot?, project?}` |
| GET | `/scratchpad?session_id=...&project=...` | Return scratchpad text (called by hooks) |
| POST | `/maintain` | Run the maintenance handler. Body: `{project?}` |
| GET | `/health` | Server status, TLS/auth state, project count |
| GET | `/projects` | Full project listing |
| POST/GET/DELETE | `/mcp` | MCP StreamableHTTP transport endpoint |

All routes require `Authorization: Bearer <token>` when `DRAM_AUTH_TOKEN` is set.

---

## Hooks (Claude Code)

Two hooks snapshot state before Claude Code compacts and re-hydrate it afterward.

### Install

1. Copy `pre-compact.sh` and `session-start.sh` into `.claude/hooks/` in your project.
2. Merge the `hooks` block from `settings.json` into your `.claude/settings.json`.
3. `chmod +x .claude/hooks/*.sh`
4. Restart Claude Code, run `/hooks` to confirm registration.

See [SETUP.md](SETUP.md) for full details.

### How they work

- **`pre-compact.sh`** (PreCompact) — snapshots the full uncompressed transcript into `.claude/state/recovery/` before automatic compaction. Keeps the 5 most recent.
- **`session-start.sh`** (SessionStart) — on resume after compaction, injects a directive telling the model to re-read `scratchpad.md` and call `restore()`.

Point the hooks at the HTTP server to sync:

```bash
export MEMORY_SERVER_URL="http://localhost:3577"
# or with TLS:
export MEMORY_SERVER_URL="https://localhost:3577"
```

Without `MEMORY_SERVER_URL`, the hooks use local files only and are fully functional.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DRAM_DATA_DIR` | `~/.dram/` | Data directory (nodes, index, scratchpads) |
| `DRAM_HTTP_PORT` | `3577` | HTTP/HTTPS server port |
| `DRAM_HTTP_HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` for remote access. |
| `DRAM_TRANSPORT` | `stdio` | Transport mode: `stdio`, `http`, or `both` |
| `DRAM_AUTH_TOKEN` | *(disabled)* | Bearer token for HTTP auth. Set this for any non-localhost deployment. |
| `DRAM_TLS` | `off` | TLS mode: `off`, `auto` (self-signed), or `custom` (your certs) |
| `DRAM_TLS_CERT` | — | Path to PEM certificate (required when `DRAM_TLS=custom`) |
| `DRAM_TLS_KEY` | — | Path to PEM private key (required when `DRAM_TLS=custom`) |
| `DRAM_TLS_DIR` | `~/.dram/certs/` | Directory for auto-generated certificates |
| `DRAM_PROJECTS_ALLOW` | *(all)* | Comma-separated project IDs to expose. Omit for all. |
| `DRAM_CORS_ORIGINS` | *(none)* | Allowed CORS origins. `*` for all, or comma-separated list. |
| `DRAM_EMBEDDING_PROVIDER` | `ollama` | Embedding backend: `ollama` or `none` |
| `DRAM_OLLAMA_URL` | `http://localhost:11434` | Ollama API base URL |
| `DRAM_EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model |

---

## Architecture

### Memory tiers

| Tier | Lifetime | Purpose |
|------|----------|---------|
| **Durable** (graph) | Permanent | Knowledge graph of markdown nodes with typed edges. Survives across all sessions. |
| **Scratchpad** | Current task | Distilled working state. Survives context compaction within a session. Archived on task completion. |
| **Conversation** | Context window | Volatile. Never the system of record. |

### How it works

Each memory node is a markdown file with YAML frontmatter: id, type, status, timestamps, and typed edges (`depends_on`, `part_of`, `supersedes`, `relates_to`). SQLite indexes the nodes for search. If the index gets corrupted, `npm run rebuild-index` re-derives it from the markdown files on disk.

When a node is committed, DRAM extracts entities (code identifiers, file paths, technical terms) and claims (declarative sentences) from its content. Nodes that share entities automatically get derived edges connecting them — this catches relationships the agent forgot to link explicitly. If Ollama is running, node content is also embedded for semantic similarity search.

`read_subgraph` ranks candidates using multiple signals: embedding similarity, keyword matches, entity overlap with the query, recency, and in-degree (how many other nodes link to it). It seeds from the top matches, expands one hop along edges weighted by relationship type, and trims to a token budget.

### Design principles

1. Markdown files are source of truth; SQLite is a derived index, rebuildable.
2. Three tiers: durable graph, task scratchpad, volatile conversation. State never lives only in the volatile tier.
3. Store distilled state, not transcripts.
4. Never hard-delete — demote, supersede, or archive.
5. Projects are isolated by default; cross-project federation is opt-in.

### Project layout

```
server/src/
├── index.ts          — Entry point, starts MCP + HTTP
├── store.ts          — Storage: scratchpads, markdown nodes, SQLite index, enrichment
├── project-manager.ts — Multi-project orchestration, registry, federation
├── tools.ts          — MCP tool definitions with multi-signal ranking
├── http.ts           — HTTP/HTTPS routes, StreamableHTTP MCP transport, CORS
├── tls.ts            — TLS certificate management (auto-gen + custom)
├── auth.ts           — Bearer token validation (timing-safe)
├── transport.ts      — McpServer factory, transport mode detection
├── types.ts          — Shared type definitions
├── embeddings.ts     — Pluggable embedding providers (Ollama, Noop)
├── extraction.ts     — Entity and claim extraction from node content
├── maintenance.ts    — Importance scoring, demotion, community detection
└── rebuild-index.ts  — CLI to re-derive index from markdown files

protocols/
├── claude-app.md     — Claude app Project instructions
├── claude-api.md     — System prompt template for API users
└── codex.md          — OpenAI Codex protocol

examples/
└── api-client.ts     — Claude API + DRAM agentic loop example
```

### Data layout

```
~/.dram/
├── config.json                # Project registry
├── certs/                     # Auto-generated TLS certificates
│   ├── cert.pem
│   └── key.pem
└── projects/
    ├── _default/              # Default project
    │   ├── index.db           # SQLite derived index
    │   ├── nodes/             # Markdown source-of-truth
    │   │   ├── abc123.md
    │   │   └── ...
    │   ├── scratchpads/       # Active session state
    │   └── archive/
    │       └── scratchpads/   # Completed task scratchpads
    ├── my-app/
    │   └── ...
    └── my-library/
        └── ...
```

---

## Working-memory protocol

The protocol agents follow to use DRAM effectively:

1. **On start or resume** — call `restore(session_id)` first. Re-establish the task, decisions already made, and current step before acting. Never re-plan something already recorded.

2. **After each meaningful step** — call `checkpoint(session_id, state)` with distilled state: the task as stated, decisions and why, current progress, open questions, and hard constraints.

3. **On task completion** — call `commit_task(session_id, residue)` to persist what future tasks will need into the graph. The scratchpad is archived and cleared automatically.

Use `read_subgraph(task)` at the start of a new task to load relevant context from the graph before beginning work.

Ready-to-paste protocol instructions for each surface are in [protocols/](protocols/).

---

## Status

The server supports three transport modes (`stdio`, `http`, `both`) with optional TLS (auto-generated or custom certificates), bearer-token authentication, CORS, project allowlisting, and multi-project isolation with optional cross-project federation.

Ready-to-paste protocol instructions ship for the Claude app, API, and Codex. An example API client demonstrates the agentic loop with context editing.

An end-to-end test suite (`npm test`) validates compaction survival, reversibility, retrieval precision, supersession chain preservation, enrichment pipeline, maintenance correctness, and index rebuild from markdown source of truth.

## License

MIT
