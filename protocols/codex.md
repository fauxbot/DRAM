# DRAM Protocol — OpenAI Codex (VS Code / CLI)

Setup guide for using DRAM with the OpenAI Codex extension for VS Code or the Codex CLI.

## MCP server configuration

### Per-project (isolated memory)

Create `.codex/config.toml` in the project root:

```toml
[mcp_servers.dram]
command = "node"
args = ["/absolute/path/to/gmemory/server/dist/index.js", "--data-dir", "/path/to/.dram/my-project"]
env = { "DRAM_TRANSPORT" = "stdio" }
startup_timeout_sec = 15
```

### Global (shared memory)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.dram]
command = "node"
args = ["/absolute/path/to/gmemory/server/dist/index.js"]
env = { "DRAM_TRANSPORT" = "stdio" }
startup_timeout_sec = 15
```

### Verify

Run `/mcp` in the Codex chat or `codex /mcp` from the CLI. You should see `dram` listed with its five tools.

## AGENTS.md protocol instructions

Add the following to your project's `AGENTS.md` (the Codex equivalent of `CLAUDE.md`). This embeds the memory protocol so the agent follows it automatically.

---

```markdown
## Working memory (DRAM)

A persistent memory server is connected via MCP. It stores a knowledge graph that survives across sessions and a task scratchpad that survives context compaction. Use it to maintain continuity.

### Tools

- **restore(session_id)** — Load the current scratchpad. Call first on every session start or resume.
- **checkpoint(session_id, state)** — Save distilled working state. Keep it concise.
- **commit_task(session_id, residue)** — Persist knowledge to the graph and clear the scratchpad. Call on task completion.
- **read_subgraph(task, budget?)** — Load task-relevant nodes from the graph (default 4000 tokens).
- **maintain(dry_run?)** — Run graph maintenance. Call occasionally, not every session.

### Protocol

1. **On start** — Call `restore(session_id)` before any other action. Use a stable session ID (e.g., the project name). Re-establish task, decisions, and progress before acting. Do not re-plan anything already recorded.

2. **After each meaningful step** — Call `checkpoint(session_id, state)` with:
   - The task as originally stated
   - Decisions made and why
   - Current progress
   - Open questions and constraints

3. **On task completion** — Call `commit_task(session_id, residue)` with nodes to persist. Use typed links: `depends_on`, `part_of`, `supersedes`, `relates_to`. To replace a prior decision, link with `supersedes` — never delete.

4. **On new task** — Call `read_subgraph(task)` to load relevant prior context before starting.

5. **When unsure of current state** — Stop and call `restore()` before continuing.

### Rules

- Checkpoint often — context may be compacted at any time.
- Store distilled state, not transcripts.
- Never hard-delete nodes. Supersede or archive instead.
- The scratchpad must stay small enough to reload in full.
```

---

## Notes

- Codex supports **stdio MCP only** — no remote HTTP connections. The server runs as a local subprocess.
- The same `config.toml` is shared between the Codex CLI and VS Code extension.
- Use `--data-dir` to isolate memory per project, or omit it to share a single graph across projects.
- Restart the Codex extension or CLI after changing `config.toml`.
