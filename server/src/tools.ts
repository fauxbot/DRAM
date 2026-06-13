import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "./store.js";

const LinkSchema = z.object({
  target: z.string().describe("Target node ID"),
  type: z.enum(["depends_on", "part_of", "supersedes", "relates_to"]),
});

const NodeInputSchema = z.object({
  id: z
    .string()
    .optional()
    .describe("Existing node ID to update; omit to create new"),
  title: z.string().describe("Node title"),
  type: z
    .string()
    .describe("Node type: decision, fact, context, task, pattern, etc."),
  content: z.string().describe("Node content in markdown"),
  links: z.array(LinkSchema).optional().describe("Typed links to other nodes"),
});

export function registerTools(server: McpServer, store: Store): void {
  server.tool(
    "restore",
    "Return the current scratchpad for this session. Call on start or resume before any other action.",
    {
      session_id: z.string().describe("The current session ID"),
    },
    async ({ session_id }) => {
      const content = store.getScratchpad(session_id);
      return {
        content: [
          {
            type: "text" as const,
            text: content || "(no scratchpad found for this session)",
          },
        ],
      };
    }
  );

  server.tool(
    "checkpoint",
    "Save distilled working state for this session. Overwrite current-state in place; append decisions with explicit supersession.",
    {
      session_id: z.string().describe("The current session ID"),
      state: z
        .string()
        .describe(
          "Distilled scratchpad: task, decisions, progress, open questions, constraints"
        ),
    },
    async ({ session_id, state }) => {
      store.saveScratchpad(session_id, state);
      return {
        content: [{ type: "text" as const, text: "Scratchpad saved." }],
      };
    }
  );

  server.tool(
    "commit_task",
    "Persist what future tasks need into the graph and clear the scratchpad. Call when the current task is complete. Atomic: nodes are written before the scratchpad is cleared.",
    {
      session_id: z.string().describe("The current session ID"),
      residue: z.object({
        nodes: z.array(NodeInputSchema).describe("Nodes to create or update"),
        summary: z
          .string()
          .optional()
          .describe("Optional task completion summary"),
      }),
    },
    async ({ session_id, residue }) => {
      const result = store.commitTask(session_id, residue);
      const ids = result.nodes.map((n) => n.id);
      return {
        content: [
          {
            type: "text" as const,
            text: `Task committed. ${result.nodes.length} node(s) persisted [${ids.join(", ")}]. Scratchpad archived and cleared.`,
          },
        ],
      };
    }
  );

  server.tool(
    "read_subgraph",
    "Return the task-relevant neighborhood of the graph. Seeds by keyword match, expands one hop via edges, trims to a token budget.",
    {
      task: z.string().describe("Description of the current task"),
      budget: z
        .number()
        .optional()
        .default(4000)
        .describe("Approximate token budget for the returned subgraph"),
    },
    async ({ task, budget }) => {
      const seeds = store.searchNodes(task);

      // Expand one hop from seeds
      const seen = new Set<string>();
      const expanded: typeof seeds = [];
      for (const node of seeds) {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          expanded.push(node);
        }
        for (const neighbor of store.getNodeNeighbors(node.id)) {
          if (!seen.has(neighbor.id)) {
            seen.add(neighbor.id);
            expanded.push(neighbor);
          }
        }
      }

      // Trim to budget (~4 chars per token)
      const charBudget = budget * 4;
      let totalChars = 0;
      const included: typeof expanded = [];

      for (const node of expanded) {
        const nodeText = formatNode(node);
        if (totalChars + nodeText.length > charBudget && included.length > 0)
          break;
        included.push(node);
        totalChars += nodeText.length;
      }

      if (included.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No relevant nodes found in the graph.",
            },
          ],
        };
      }

      const text = included.map(formatNode).join("\n\n---\n\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${included.length} relevant node(s) (${expanded.length - included.length} trimmed by budget):\n\n${text}`,
          },
        ],
      };
    }
  );
}

function formatNode(n: {
  id: string;
  title: string;
  type: string;
  status: string;
  updated: string;
  links: Array<{ target: string; type: string }>;
  content: string;
}): string {
  const links =
    n.links.length > 0
      ? `\nLinks: ${n.links.map((l) => `${l.type} → ${l.target}`).join(", ")}`
      : "";
  return `## ${n.title}\n- id: ${n.id}\n- type: ${n.type}\n- updated: ${n.updated}${links}\n\n${n.content}`;
}
