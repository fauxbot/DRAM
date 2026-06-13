/**
 * DRAM + Claude API — agentic loop with persistent memory and context editing.
 *
 * Prerequisites:
 *   DRAM server running in HTTP mode:
 *     DRAM_TRANSPORT=http DRAM_AUTH_TOKEN=secret npm start
 *   Environment:
 *     ANTHROPIC_API_KEY  — your Claude API key
 *     DRAM_URL           — DRAM MCP endpoint (default http://localhost:3577/mcp)
 *     DRAM_AUTH_TOKEN     — must match the server's token
 *
 * Run:
 *   npx tsx examples/api-client.ts "Summarize the key decisions in our project"
 */

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SESSION_ID = "api-client-demo";
const MAX_TURNS = 20;
const TOKEN_BUDGET = 100_000;
const PRUNE_THRESHOLD = 0.8;
const DRAM_TOOLS = new Set(["restore", "checkpoint", "commit_task", "read_subgraph", "maintain"]);

// --- MCP client setup ---

async function connectDram(): Promise<Client> {
  const url = process.env.DRAM_URL || "http://localhost:3577/mcp";
  const token = process.env.DRAM_AUTH_TOKEN || "";

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  });

  const client = new Client({ name: "dram-api-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// Convert MCP tool definitions to Claude API format
async function getToolDefinitions(mcp: Client): Promise<Anthropic.Tool[]> {
  const { tools } = await mcp.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

// --- Context editing ---

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function isDramToolResult(block: Anthropic.ToolResultBlockParam): boolean {
  return DRAM_TOOLS.has(block.tool_use_id?.split("_")[0] || "");
}

// Tag tool_result blocks with the tool name for filtering later.
// We embed the tool name in a wrapper so pruning can identify DRAM results.
interface TaggedToolResult extends Anthropic.ToolResultBlockParam {
  _toolName?: string;
}

function pruneMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // Keep the last 6 messages unconditionally
  const keepRecent = 6;
  if (messages.length <= keepRecent) return messages;

  const recent = messages.slice(-keepRecent);
  const older = messages.slice(0, -keepRecent);

  // From older messages, keep only those containing DRAM tool results
  const kept = older.filter((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return false;
    return (msg.content as Anthropic.ContentBlockParam[]).some(
      (block) =>
        block.type === "tool_result" &&
        (block as TaggedToolResult)._toolName &&
        DRAM_TOOLS.has((block as TaggedToolResult)._toolName!)
    );
  });

  return [...kept, ...recent];
}

// --- Main loop ---

async function main() {
  const userTask = process.argv[2] || "What do you know about this project?";

  const anthropic = new Anthropic();
  const mcp = await connectDram();
  const tools = await getToolDefinitions(mcp);

  const systemPrompt = `You are an AI assistant with persistent memory powered by DRAM.

Memory protocol:
1. On start — call restore("${SESSION_ID}") immediately, then read_subgraph with the user's task.
2. After meaningful progress — call checkpoint("${SESSION_ID}", state) with distilled state.
3. On task completion — call commit_task("${SESSION_ID}", residue) to persist insights.

Node types: decision, fact, context, task, pattern.
Link types: depends_on, part_of, supersedes, relates_to.
Never delete — use supersedes to replace prior decisions.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userTask },
  ];

  console.log(`\nUser: ${userTask}\n`);

  // Track tool_use id → tool name for context editing
  const toolNameMap = new Map<string, string>();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Context editing: prune if over budget
    if (estimateTokens(messages) > TOKEN_BUDGET * PRUNE_THRESHOLD) {
      console.log("[context edit] Pruning old non-memory messages");
      const pruned = pruneMessages(messages);
      messages.length = 0;
      messages.push(...pruned);
    }

    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: systemPrompt,
      tools,
      messages,
    });

    // Build assistant message (include all content blocks)
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    // Process response blocks
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        console.log(`Assistant: ${block.text}`);
      } else if (block.type === "tool_use") {
        console.log(`[tool] ${block.name}(${JSON.stringify(block.input)})`);
        toolNameMap.set(block.id, block.name);

        try {
          const result = await mcp.callTool({
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });
          const text = result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");

          console.log(`[result] ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);

          const toolResult: TaggedToolResult = {
            type: "tool_result",
            tool_use_id: block.id,
            content: text,
            _toolName: block.name,
          };
          toolResults.push(toolResult);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.log(`[error] ${errorMsg}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: ${errorMsg}`,
            is_error: true,
          });
        }
      }
    }

    if (response.stop_reason === "end_turn") break;

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }

  await mcp.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
