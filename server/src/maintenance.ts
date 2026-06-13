import type Database from "better-sqlite3";
import type { Store } from "./store.js";

export interface ImportanceScore {
  nodeId: string;
  title: string;
  recency: number;
  inDegree: number;
  outDegree: number;
  entityCount: number;
  isSuperseded: boolean;
  isLeaf: boolean;
  total: number;
}

export interface MaintenanceResult {
  scored: number;
  demoted: string[];
  supersessionMarked: string[];
  danglingEdgesRepaired: number;
  communities: number;
  log: string[];
}

export class MaintenanceHandler {
  private store: Store;
  private db: Database.Database;

  constructor(store: Store, db: Database.Database) {
    this.store = store;
    this.db = db;
  }

  async run(): Promise<MaintenanceResult> {
    const log: string[] = [];
    const result: MaintenanceResult = {
      scored: 0,
      demoted: [],
      supersessionMarked: [],
      danglingEdgesRepaired: 0,
      communities: 0,
      log,
    };

    log.push(`maintenance started at ${new Date().toISOString()}`);

    // 1. Score all active nodes by importance
    const scores = this.scoreAllNodes();
    result.scored = scores.length;
    log.push(`scored ${scores.length} active nodes`);

    // 2. Mark superseded nodes
    const superseded = this.markSuperseded();
    result.supersessionMarked = superseded;
    if (superseded.length > 0) {
      log.push(`marked ${superseded.length} node(s) as superseded: ${superseded.join(", ")}`);
    }

    // 3. Demote stale low-importance leaf nodes
    const demoted = this.demoteStaleLeaves(scores);
    result.demoted = demoted;
    if (demoted.length > 0) {
      log.push(`demoted ${demoted.length} stale leaf node(s): ${demoted.join(", ")}`);
    }

    // 4. Repair dangling edges
    const repaired = this.repairDanglingEdges();
    result.danglingEdgesRepaired = repaired;
    if (repaired > 0) {
      log.push(`repaired ${repaired} dangling edge(s)`);
    }

    // 5. Detect communities and generate summaries
    const communities = this.detectCommunities();
    result.communities = communities;
    log.push(`detected ${communities} communit${communities === 1 ? "y" : "ies"}`);

    // 6. Log the maintenance run
    this.recordRun(result);
    log.push("maintenance complete");

    return result;
  }

  // ── Importance scoring ──────────────────────────────────────

  scoreAllNodes(): ImportanceScore[] {
    const now = Date.now();
    const nodes = this.db
      .prepare(
        `SELECT id, title, status, updated FROM nodes WHERE status = 'active'`
      )
      .all() as { id: string; title: string; status: string; updated: string }[];

    const scores: ImportanceScore[] = [];
    let maxInDegree = 1;
    let maxOutDegree = 1;
    let maxEntities = 1;

    // First pass: raw values
    const raw = nodes.map((n) => {
      const inDeg = this.getInDegreeAll(n.id);
      const outDeg = this.getOutDegree(n.id);
      const entCount = this.getEntityCount(n.id);
      const ageHours = Math.max(1, (now - new Date(n.updated).getTime()) / 3_600_000);
      const isSuperseded = this.isTargetOfSupersedes(n.id);
      const isLeaf = inDeg === 0;

      maxInDegree = Math.max(maxInDegree, inDeg);
      maxOutDegree = Math.max(maxOutDegree, outDeg);
      maxEntities = Math.max(maxEntities, entCount);

      return { ...n, inDeg, outDeg, entCount, ageHours, isSuperseded, isLeaf };
    });

    // Second pass: normalize and compute total
    for (const n of raw) {
      const recency = 1 / (1 + Math.log2(n.ageHours));
      const normIn = n.inDeg / maxInDegree;
      const normOut = n.outDeg / maxOutDegree;
      const normEnt = n.entCount / maxEntities;

      // High in-degree is heavily weighted — never auto-prune popular nodes
      const total =
        0.25 * recency +
        0.35 * normIn +
        0.15 * normOut +
        0.15 * normEnt +
        (n.isSuperseded ? -0.3 : 0);

      scores.push({
        nodeId: n.id,
        title: n.title,
        recency,
        inDegree: n.inDeg,
        outDegree: n.outDeg,
        entityCount: n.entCount,
        isSuperseded: n.isSuperseded,
        isLeaf: n.isLeaf,
        total: Math.max(0, total),
      });
    }

    return scores.sort((a, b) => b.total - a.total);
  }

  // ── Supersession detection ──────────────────────────────────

  private markSuperseded(): string[] {
    // Find nodes that are the target of a "supersedes" edge from an active node
    const targets = this.db
      .prepare(
        `SELECT DISTINCT e.target_id FROM edges e
         JOIN nodes src ON src.id = e.source_id AND src.status = 'active'
         JOIN nodes tgt ON tgt.id = e.target_id AND tgt.status = 'active'
         WHERE e.type = 'supersedes'`
      )
      .all() as { target_id: string }[];

    const marked: string[] = [];
    for (const { target_id } of targets) {
      this.store.updateNode(target_id, { status: "superseded" });
      marked.push(target_id);
      this.logAction("supersede", target_id, "marked as superseded by active successor");
    }
    return marked;
  }

  // ── Stale leaf demotion ─────────────────────────────────────

  private demoteStaleLeaves(scores: ImportanceScore[]): string[] {
    const demoted: string[] = [];
    const STALE_THRESHOLD = 0.15;
    const MIN_AGE_HOURS = 168; // 7 days

    for (const score of scores) {
      if (!score.isLeaf) continue;
      if (score.inDegree > 0) continue; // not truly a leaf
      if (score.total >= STALE_THRESHOLD) continue;
      if (score.recency > 0.5) continue; // too recent

      // Check age — don't demote anything less than a week old
      const node = this.db
        .prepare("SELECT updated FROM nodes WHERE id = ?")
        .get(score.nodeId) as { updated: string } | undefined;
      if (!node) continue;

      const ageHours =
        (Date.now() - new Date(node.updated).getTime()) / 3_600_000;
      if (ageHours < MIN_AGE_HOURS) continue;

      this.store.updateNode(score.nodeId, { status: "archived" });
      demoted.push(score.nodeId);
      this.logAction(
        "demote",
        score.nodeId,
        `leaf node with importance ${score.total.toFixed(3)}, age ${Math.round(ageHours)}h`
      );
    }

    return demoted;
  }

  // ── Dangling edge repair ────────────────────────────────────

  private repairDanglingEdges(): number {
    let repaired = 0;

    // Explicit edges pointing to non-existent nodes
    const danglingExplicit = this.db
      .prepare(
        `SELECT e.source_id, e.target_id, e.type FROM edges e
         WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.target_id)`
      )
      .all() as { source_id: string; target_id: string; type: string }[];

    for (const edge of danglingExplicit) {
      this.db
        .prepare(
          "DELETE FROM edges WHERE source_id = ? AND target_id = ? AND type = ?"
        )
        .run(edge.source_id, edge.target_id, edge.type);
      this.logAction(
        "repair_edge",
        edge.source_id,
        `removed dangling explicit edge → ${edge.target_id} (${edge.type})`
      );
      repaired++;
    }

    // Derived edges pointing to non-existent or archived nodes
    const danglingDerived = this.db
      .prepare(
        `SELECT d.source_id, d.target_id, d.type FROM derived_edges d
         WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = d.target_id AND n.status = 'active')`
      )
      .all() as { source_id: string; target_id: string; type: string }[];

    for (const edge of danglingDerived) {
      this.db
        .prepare(
          "DELETE FROM derived_edges WHERE source_id = ? AND target_id = ? AND type = ?"
        )
        .run(edge.source_id, edge.target_id, edge.type);
      repaired++;
    }

    // Also clean edges FROM archived/superseded nodes
    const staleSourceExplicit = this.db
      .prepare(
        `SELECT e.source_id, e.target_id, e.type FROM edges e
         WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.source_id)`
      )
      .all() as { source_id: string; target_id: string; type: string }[];

    for (const edge of staleSourceExplicit) {
      this.db
        .prepare(
          "DELETE FROM edges WHERE source_id = ? AND target_id = ? AND type = ?"
        )
        .run(edge.source_id, edge.target_id, edge.type);
      repaired++;
    }

    return repaired;
  }

  // ── Community detection ─────────────────────────────────────
  // Simple connected-component detection via union-find.
  // Each component with 2+ nodes gets a summary node.

  private detectCommunities(): number {
    const activeNodes = this.db
      .prepare("SELECT id, title FROM nodes WHERE status = 'active'")
      .all() as { id: string; title: string }[];

    if (activeNodes.length < 3) return 0;

    // Build adjacency from explicit + derived edges between active nodes
    const activeIds = new Set(activeNodes.map((n) => n.id));
    const parent = new Map<string, string>();

    function find(x: string): string {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cur = x;
      while (cur !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    }

    function union(a: string, b: string) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    for (const n of activeNodes) parent.set(n.id, n.id);

    const allEdges = this.db
      .prepare(
        `SELECT source_id, target_id FROM edges
         UNION
         SELECT source_id, target_id FROM derived_edges`
      )
      .all() as { source_id: string; target_id: string }[];

    for (const e of allEdges) {
      if (activeIds.has(e.source_id) && activeIds.has(e.target_id)) {
        union(e.source_id, e.target_id);
      }
    }

    // Group into communities
    const communities = new Map<string, string[]>();
    for (const n of activeNodes) {
      const root = find(n.id);
      const group = communities.get(root) || [];
      group.push(n.id);
      communities.set(root, group);
    }

    // Create/update summary nodes for communities with 3+ members
    let count = 0;
    for (const [, members] of communities) {
      if (members.length < 3) continue;

      const memberNodes = members
        .map((id) => {
          const row = this.db
            .prepare("SELECT id, title, type, content_preview FROM nodes WHERE id = ?")
            .get(id) as { id: string; title: string; type: string; content_preview: string } | undefined;
          return row;
        })
        .filter((r) => r !== undefined);

      const titles = memberNodes.map((n) => `- ${n.title} (${n.type})`).join("\n");
      const summaryContent = `Community of ${members.length} related nodes:\n\n${titles}`;
      const summaryTitle = `Community: ${memberNodes.slice(0, 3).map((n) => n.title).join(", ")}${members.length > 3 ? ` (+${members.length - 3} more)` : ""}`;

      // Check if a community summary already exists for these members
      const existingId = this.findExistingCommunitySummary(members);
      if (existingId) {
        this.store.updateNode(existingId, {
          title: summaryTitle,
          content: summaryContent,
        });
      } else {
        const summaryNode = this.store.createNode({
          title: summaryTitle,
          type: "community_summary",
          content: summaryContent,
          links: members.map((id) => ({
            target: id,
            type: "part_of" as const,
          })),
        });
        this.logAction(
          "community",
          summaryNode.id,
          `created summary for ${members.length} nodes`
        );
      }
      count++;
    }

    return count;
  }

  private findExistingCommunitySummary(memberIds: string[]): string | null {
    const summaries = this.db
      .prepare(
        "SELECT id FROM nodes WHERE type = 'community_summary' AND status = 'active'"
      )
      .all() as { id: string }[];

    for (const s of summaries) {
      const targets = this.db
        .prepare("SELECT target_id FROM edges WHERE source_id = ? AND type = 'part_of'")
        .all(s.id) as { target_id: string }[];
      const targetSet = new Set(targets.map((t) => t.target_id));
      const overlap = memberIds.filter((id) => targetSet.has(id)).length;
      if (overlap >= memberIds.length * 0.6) {
        return s.id;
      }
    }

    return null;
  }

  // ── Maintenance log ─────────────────────────────────────────

  private logAction(action: string, nodeId: string, detail: string): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_log (action, node_id, detail, timestamp)
         VALUES (?, ?, ?, ?)`
      )
      .run(action, nodeId, detail, new Date().toISOString());
  }

  private recordRun(result: MaintenanceResult): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_log (action, node_id, detail, timestamp)
         VALUES ('run_complete', '', ?, ?)`
      )
      .run(
        JSON.stringify({
          scored: result.scored,
          demoted: result.demoted.length,
          supersessionMarked: result.supersessionMarked.length,
          danglingEdgesRepaired: result.danglingEdgesRepaired,
          communities: result.communities,
        }),
        new Date().toISOString()
      );
  }

  // ── Helpers ─────────────────────────────────────────────────

  private getInDegreeAll(id: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM (
           SELECT source_id FROM edges WHERE target_id = ?
           UNION ALL
           SELECT source_id FROM derived_edges WHERE target_id = ?
         )`
      )
      .get(id, id) as { cnt: number };
    return row.cnt;
  }

  private getOutDegree(id: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM (
           SELECT target_id FROM edges WHERE source_id = ?
           UNION ALL
           SELECT target_id FROM derived_edges WHERE source_id = ?
         )`
      )
      .get(id, id) as { cnt: number };
    return row.cnt;
  }

  private getEntityCount(id: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM entities WHERE node_id = ?")
      .get(id) as { cnt: number };
    return row.cnt;
  }

  private isTargetOfSupersedes(id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM edges
         WHERE target_id = ? AND type = 'supersedes'
         AND source_id IN (SELECT id FROM nodes WHERE status = 'active')`
      )
      .get(id) as { cnt: number };
    return row.cnt > 0;
  }
}
