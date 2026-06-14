import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "./store.js";
import type { MemoryNode } from "./types.js";
import { extractEntities } from "./extraction.js";
import { MaintenanceHandler } from "./maintenance.js";

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

export interface ScoredNode {
  node: MemoryNode;
  similarity: number;
  keywordScore: number;
  entityOverlap: number;
  recency: number;
  inDegree: number;
  finalScore: number;
}

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
    "Persist what future tasks need into the graph and clear the scratchpad. Call when the current task is complete. Atomic: nodes are written before the scratchpad is cleared. Runs entity extraction, embedding, and derived-edge generation on committed nodes.",
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

      // Enrich committed nodes (extraction + embeddings + derived edges)
      await store.enrichAfterCommit(ids);

      return {
        content: [
          {
            type: "text" as const,
            text: `Task committed. ${result.nodes.length} node(s) persisted [${ids.join(", ")}], enriched with entities and embeddings. Scratchpad archived and cleared.`,
          },
        ],
      };
    }
  );

  server.tool(
    "read_subgraph",
    "Return the task-relevant neighborhood of the graph. Seeds by semantic similarity (when embeddings are available) and keyword match. Expands along typed edges weighted by relationship type. Ranks by similarity, recency, connectivity, and entity overlap. Trims to a token budget.",
    {
      task: z.string().describe("Description of the current task"),
      budget: z
        .number()
        .optional()
        .default(4000)
        .describe("Approximate token budget for the returned subgraph"),
    },
    async ({ task, budget }) => {
      const scored = await rankSubgraph(store, task);

      if (scored.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No relevant nodes found in the graph.",
            },
          ],
        };
      }

      // Trim to budget (~4 chars per token)
      const charBudget = budget * 4;
      let totalChars = 0;
      const included: ScoredNode[] = [];

      for (const entry of scored) {
        const nodeText = formatNode(entry);
        if (totalChars + nodeText.length > charBudget && included.length > 0)
          break;
        included.push(entry);
        totalChars += nodeText.length;
      }

      const text = included.map(formatNode).join("\n\n---\n\n");
      const trimmed = scored.length - included.length;
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${included.length} relevant node(s)${trimmed > 0 ? ` (${trimmed} trimmed by budget)` : ""}:\n\n${text}`,
          },
        ],
      };
    }
  );

  server.tool(
    "maintain",
    "Run the maintenance handler: score node importance, mark superseded nodes, demote stale leaves, repair dangling edges, detect communities and generate summary nodes. Safe and reversible — demotes and archives, never deletes. Use dry_run to preview what would change.",
    {
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe("Preview changes without applying them"),
    },
    async ({ dry_run }) => {
      const handler = new MaintenanceHandler(store, store.getDb(), { dryRun: dry_run });
      const result = await handler.run();

      const lines = [
        `Maintenance ${dry_run ? "preview" : "complete"}:`,
        `- ${result.scored} nodes scored`,
        `- ${result.supersessionMarked.length} marked superseded`,
        `- ${result.demoted.length} stale leaves demoted`,
        `- ${result.danglingEdgesRepaired} dangling edges repaired`,
        `- ${result.communities} communities detected`,
      ];

      if (result.skippedDemotion.length > 0) {
        lines.push(`- ${result.skippedDemotion.length} skipped demotion (type protection or too young)`);
      }
      if (result.cappedDemotion.length > 0) {
        lines.push(`- ${result.cappedDemotion.length} deferred by per-run cap`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n"),
          },
        ],
      };
    }
  );
}

export async function rankSubgraph(
  store: Store,
  task: string
): Promise<ScoredNode[]> {
  const candidates = new Map<string, ScoredNode>();
  const now = Date.now();

  function addCandidate(node: MemoryNode, overrides?: Partial<ScoredNode>) {
    if (candidates.has(node.id)) {
      const existing = candidates.get(node.id)!;
      if (overrides?.similarity)
        existing.similarity = Math.max(existing.similarity, overrides.similarity);
      if (overrides?.keywordScore)
        existing.keywordScore = Math.max(existing.keywordScore, overrides.keywordScore);
      if (overrides?.entityOverlap)
        existing.entityOverlap = Math.max(existing.entityOverlap, overrides.entityOverlap);
      return;
    }
    const updatedMs = new Date(node.updated).getTime();
    const ageHours = Math.max(1, (now - updatedMs) / 3_600_000);
    const recency = 1 / (1 + Math.log2(ageHours));

    candidates.set(node.id, {
      node,
      similarity: 0,
      keywordScore: 0,
      entityOverlap: 0,
      recency,
      inDegree: 0,
      finalScore: 0,
      ...overrides,
    });
  }

  // Signal 1: Semantic similarity (if embeddings available)
  const semanticResults = await store.semanticSearch(task, 15);
  for (const { node, similarity } of semanticResults) {
    addCandidate(node, { similarity });
  }

  // Signal 2: Keyword match
  const keywordResults = store.searchNodes(task, 15);
  const keywords = task
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 2);
  for (const node of keywordResults) {
    const text = `${node.title} ${node.content}`.toLowerCase();
    let hits = 0;
    for (const k of keywords) {
      if (text.includes(k)) hits++;
    }
    const keywordScore = keywords.length > 0 ? hits / keywords.length : 0;
    addCandidate(node, { keywordScore });
  }

  // Signal 3: Entity overlap
  const taskEntities = extractEntities(task);
  if (taskEntities.length > 0) {
    const seen = new Set<string>();
    for (const entity of taskEntities) {
      const nodes = store.findNodesByEntity(entity.name);
      for (const node of nodes) {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          const nodeEntities = store.getNodeEntities(node.id);
          const overlap =
            taskEntities.filter((te) =>
              nodeEntities.some(
                (ne) => ne.name.toLowerCase() === te.name.toLowerCase()
              )
            ).length / taskEntities.length;
          addCandidate(node, { entityOverlap: overlap });
        }
      }
    }
  }

  // Expand one hop from seed nodes along weighted edges
  const seeds = [...candidates.keys()];
  for (const seedId of seeds) {
    const seedScore = candidates.get(seedId)!;
    const neighbors = store.getNodeNeighbors(seedId);
    for (const { node, weight } of neighbors) {
      const propagated = seedScore.finalScore * weight * 0.5;
      addCandidate(node, { similarity: propagated });
    }
  }

  // Compute in-degree for all candidates
  let maxInDegree = 1;
  for (const [id, entry] of candidates) {
    entry.inDegree = store.getInDegree(id);
    maxInDegree = Math.max(maxInDegree, entry.inDegree);
  }

  // Compute final score: weighted combination
  for (const entry of candidates.values()) {
    const normInDegree = entry.inDegree / maxInDegree;
    entry.finalScore =
      0.35 * entry.similarity +
      0.25 * entry.keywordScore +
      0.15 * entry.entityOverlap +
      0.15 * entry.recency +
      0.10 * normInDegree;
  }

  return [...candidates.values()]
    .filter((e) => e.finalScore > 0.01)
    .sort((a, b) => b.finalScore - a.finalScore);
}

function formatNode(entry: ScoredNode): string {
  const n = entry.node;
  const entities = entry.entityOverlap > 0 ? " [entity match]" : "";
  const sim =
    entry.similarity > 0
      ? ` [similarity: ${(entry.similarity * 100).toFixed(0)}%]`
      : "";
  const links =
    n.links.length > 0
      ? `\nLinks: ${n.links.map((l) => `${l.type} → ${l.target}`).join(", ")}`
      : "";
  return `## ${n.title}${sim}${entities}\n- id: ${n.id}\n- type: ${n.type}\n- updated: ${n.updated}\n- score: ${(entry.finalScore * 100).toFixed(1)}${links}\n\n${n.content}`;
}
