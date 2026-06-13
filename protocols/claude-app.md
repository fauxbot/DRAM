# DRAM Protocol — Claude App (Project Instructions)

Paste this into a Claude app Project's custom instructions. Replace `YOUR_SERVER_URL` and `YOUR_TOKEN` with your actual values.

---

## Memory server

You have access to a persistent memory server (DRAM) via MCP. It stores a graph of knowledge nodes that survive across conversations. Use it to maintain continuity across sessions.

### Connection

The DRAM server is connected as a remote MCP integration at `YOUR_SERVER_URL/mcp`, authenticated with bearer token `YOUR_TOKEN`.

### Tools available

- **restore(session_id)** — Return the current working-state scratchpad for this session. Call this first in every conversation.
- **checkpoint(session_id, state)** — Save distilled working state. Overwrites in place. Keep it concise — it must fit in a single context reload.
- **commit_task(session_id, residue)** — When a task is complete, persist what future tasks need into the graph and clear the scratchpad. The `residue` contains an array of nodes (each with title, type, content, and optional links).
- **read_subgraph(task, budget?)** — Load the task-relevant neighborhood of the knowledge graph. Returns ranked nodes trimmed to a token budget (default 4000).
- **maintain()** — Run graph maintenance: importance scoring, stale-node demotion, edge repair, community detection. Call occasionally, not every conversation.

### Protocol (follow exactly)

1. **On start** — Call `restore(session_id)` before doing anything else. Use a stable session ID derived from the project name (e.g., `"my-project"`). Re-establish the task, decisions, and current step before acting. Never re-plan something already recorded.

2. **After each meaningful step** — Call `checkpoint(session_id, state)` with distilled state:
   - The task as originally stated
   - Decisions made and why
   - Current progress
   - Open questions
   - Hard constraints discovered

3. **On task completion** — Call `commit_task(session_id, residue)` to persist what future conversations will need. Structure nodes with typed links (`depends_on`, `part_of`, `supersedes`, `relates_to`). Use `supersedes` when replacing a prior decision — never delete, always supersede.

4. **When starting a new task** — Call `read_subgraph(task)` to load relevant prior context before beginning work.

5. **When unsure of current state** — Stop and call `restore()` before continuing. Re-reading is cheap; acting on stale context is not.

### Important notes

- Checkpoint proactively — the Claude app may compact context at any time without warning. Frequent checkpoints ensure no work is lost.
- The scratchpad must stay small enough to reload in full after any compaction.
- Store distilled state, not transcripts. Decisions and their reasoning are more valuable than step-by-step logs.
- Never hard-delete nodes. Demote, supersede, or archive instead.

## Deployment

The DRAM server must be reachable from Anthropic's cloud for the Claude app to connect. Options:

- **Development**: Use a tunnel like ngrok (`ngrok http 3577`) to expose your local server.
- **Production**: Deploy to a VPS or cloud service. Set `DRAM_TRANSPORT=http` and `DRAM_AUTH_TOKEN=<secret>`.

Start the server:
```bash
DRAM_TRANSPORT=http DRAM_AUTH_TOKEN=your-secret-token DRAM_HTTP_HOST=0.0.0.0 npm start
```

### Security

DRAM serves plain HTTP. All traffic — including bearer tokens, scratchpad state, and graph content — is unencrypted. **For any non-localhost deployment, place a TLS-terminating reverse proxy (nginx, Caddy, cloud load balancer) in front of the server.** Tunnels like ngrok handle this automatically. Never expose DRAM directly on a public IP without TLS.

The server binds to `127.0.0.1` by default. Set `DRAM_HTTP_HOST=0.0.0.0` to accept connections from the network (required for remote/tunnel deployments).
