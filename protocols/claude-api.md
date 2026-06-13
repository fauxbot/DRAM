# DRAM Protocol — Claude API

Use this as your system prompt template when building agents with the Claude API. The API surface is the strongest enforcement point — you own the loop and can pin memory results in context.

## System prompt template

```
You are an AI assistant with persistent memory powered by DRAM. You have access to a knowledge graph that persists across conversations and a task scratchpad that survives context-window compaction.

### Memory protocol (follow exactly)

1. On start or resume — call restore() first. Re-establish the task, decisions, and current step before acting. Never re-plan or re-derive something already recorded.

2. After each meaningful step — call checkpoint() with distilled state:
   - The task as stated
   - Decisions and their reasoning
   - Current progress
   - Open questions
   - Hard constraints

3. On task completion — call commit_task() to persist what future tasks need into the graph, then the scratchpad is cleared.

4. On new task — call read_subgraph() to load relevant context before beginning.

5. When unsure — stop and call restore() before continuing.

### Node types
Use: decision, fact, context, task, pattern. Link with: depends_on, part_of, supersedes, relates_to. Never delete — use supersedes to replace prior decisions.

### Scratchpad discipline
Keep it small enough to reload in full. Store distilled state, not transcripts.
```

## Connecting via MCP client

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:3577/mcp"),
  {
    requestInit: {
      headers: {
        Authorization: "Bearer YOUR_TOKEN",
      },
    },
  }
);

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// Call DRAM tools
const result = await client.callTool({
  name: "restore",
  arguments: { session_id: "my-agent-session" },
});
```

## Context editing integration

When using the Claude API's context editing feature with DRAM, apply these rules:

1. **Pin memory results** — Never clear tool results from `restore()`, `read_subgraph()`, or `checkpoint()`. These are the agent's working memory and must persist across edits.

2. **Clear stale tool results** — At a token threshold (e.g., 80% of budget), clear old non-memory tool results (file reads, web fetches, etc.) while keeping all DRAM tool results intact.

3. **Checkpoint before clearing** — Always call `checkpoint()` before performing a context edit. This ensures the distilled state is saved even if the edit is lossy.

4. **Restore after clearing** — After a context edit that removes significant content, call `restore()` to reload the scratchpad into the fresh context.

### Example: context editing with DRAM

```typescript
// Pseudocode for a context-editing agent loop
function shouldEditContext(messages) {
  const tokens = countTokens(messages);
  return tokens > TOKEN_BUDGET * 0.8;
}

function editContext(messages) {
  // Keep: system prompt, last N user/assistant turns, ALL dram tool results
  return messages.filter((msg) => {
    if (msg.role === "system") return true;
    if (isDramToolResult(msg)) return true; // Never clear memory
    if (isRecentTurn(msg, 3)) return true;
    return false;
  });
}

// In the agent loop:
if (shouldEditContext(messages)) {
  // Checkpoint first
  await client.callTool({
    name: "checkpoint",
    arguments: { session_id, state: distillCurrentState() },
  });
  messages = editContext(messages);
}
```

## Server deployment

Start DRAM in HTTP mode for API access:

```bash
DRAM_TRANSPORT=http DRAM_AUTH_TOKEN=your-secret DRAM_HTTP_HOST=0.0.0.0 npm start
```

The server binds to `127.0.0.1` by default — set `DRAM_HTTP_HOST=0.0.0.0` when clients connect from another host or through a tunnel. Port defaults to 3577 (`DRAM_HTTP_PORT` to override). The MCP endpoint is at `/mcp`.

### Security

DRAM serves plain HTTP. All traffic — including bearer tokens, scratchpad state, and graph content — is unencrypted. **For any non-localhost deployment, place a TLS-terminating reverse proxy (nginx, Caddy, cloud load balancer) in front of the server.** Never expose DRAM directly on a public IP without TLS.
