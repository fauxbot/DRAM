import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import crypto from "crypto";
import type { MemoryNode, NodeLink, TaskResidue, SnapshotRecord } from "./types.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { cosine } from "./embeddings.js";
import { extractEntities, extractClaims } from "./extraction.js";

export class Store {
  private db: Database.Database;
  private dataDir: string;
  private scratchpadDir: string;
  private nodesDir: string;
  private archiveDir: string;
  private embedder: EmbeddingProvider | null = null;

  constructor(dataDir?: string) {
    this.dataDir =
      dataDir ||
      path.join(
        process.env.DRAM_DATA_DIR ||
          process.env.HOME ||
          process.env.USERPROFILE ||
          ".",
        ".dram"
      );
    this.scratchpadDir = path.join(this.dataDir, "scratchpads");
    this.nodesDir = path.join(this.dataDir, "nodes");
    this.archiveDir = path.join(this.dataDir, "archive", "scratchpads");

    for (const dir of [this.scratchpadDir, this.nodesDir, this.archiveDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path.join(this.dataDir, "index.db"));
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        content_preview TEXT,
        file_path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, type),
        FOREIGN KEY (source_id) REFERENCES nodes(id)
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        node_id TEXT NOT NULL,
        FOREIGN KEY (node_id) REFERENCES nodes(id)
      );

      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        node_id TEXT NOT NULL,
        FOREIGN KEY (node_id) REFERENCES nodes(id)
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        ref_type TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        vector TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        PRIMARY KEY (ref_type, ref_id)
      );

      CREATE TABLE IF NOT EXISTS derived_edges (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        reason TEXT,
        strength REAL DEFAULT 1.0,
        created TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, type)
      );

      CREATE TABLE IF NOT EXISTS maintenance_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        node_id TEXT NOT NULL,
        detail TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
      CREATE INDEX IF NOT EXISTS idx_nodes_updated ON nodes(updated);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);
      CREATE INDEX IF NOT EXISTS idx_entities_node ON entities(node_id);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_claims_node ON claims(node_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_ref ON embeddings(ref_type, ref_id);
      CREATE INDEX IF NOT EXISTS idx_derived_edges_target ON derived_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_maintenance_log_action ON maintenance_log(action);
    `);
  }

  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embedder = provider;
  }

  hasEmbeddings(): boolean {
    return this.embedder !== null && this.embedder.name !== "none";
  }

  // ── Scratchpad ──────────────────────────────────────────────

  private sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  getScratchpad(sessionId: string): string | null {
    const filePath = path.join(
      this.scratchpadDir,
      `${this.sanitizeId(sessionId)}.md`
    );
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
    return null;
  }

  saveScratchpad(sessionId: string, content: string): void {
    const filePath = path.join(
      this.scratchpadDir,
      `${this.sanitizeId(sessionId)}.md`
    );
    fs.writeFileSync(filePath, content, "utf-8");
  }

  archiveScratchpad(sessionId: string): void {
    const safeId = this.sanitizeId(sessionId);
    const srcPath = path.join(this.scratchpadDir, `${safeId}.md`);
    if (!fs.existsSync(srcPath)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destPath = path.join(this.archiveDir, `${safeId}-${timestamp}.md`);
    fs.copyFileSync(srcPath, destPath);

    const archives = fs
      .readdirSync(this.archiveDir)
      .filter((f) => f.startsWith(safeId))
      .sort()
      .reverse();
    for (const old of archives.slice(10)) {
      fs.unlinkSync(path.join(this.archiveDir, old));
    }
  }

  clearScratchpad(sessionId: string): void {
    const filePath = path.join(
      this.scratchpadDir,
      `${this.sanitizeId(sessionId)}.md`
    );
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone
    }
  }

  // ── Markdown nodes ──────────────────────────────────────────

  private nodeToMarkdown(node: MemoryNode): string {
    const frontmatter: Record<string, unknown> = {
      id: node.id,
      title: node.title,
      type: node.type,
      status: node.status,
      created: node.created,
      updated: node.updated,
    };
    if (node.links.length > 0) {
      frontmatter.links = node.links;
    }
    return matter.stringify(node.content, frontmatter);
  }

  private markdownToNode(filePath: string): MemoryNode | null {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const { data, content } = matter(raw);
      return {
        id: data.id,
        title: data.title || "",
        type: data.type || "note",
        status: data.status || "active",
        created: data.created || new Date().toISOString(),
        updated: data.updated || new Date().toISOString(),
        links: (data.links as NodeLink[]) || [],
        content: content.trim(),
      };
    } catch {
      return null;
    }
  }

  createNode(input: {
    title: string;
    type: string;
    content: string;
    links?: NodeLink[];
  }): MemoryNode {
    const now = new Date().toISOString();
    const node: MemoryNode = {
      id: crypto.randomUUID(),
      title: input.title,
      type: input.type,
      status: "active",
      created: now,
      updated: now,
      links: input.links || [],
      content: input.content,
    };
    const filePath = path.join(this.nodesDir, `${node.id}.md`);
    fs.writeFileSync(filePath, this.nodeToMarkdown(node), "utf-8");
    this.indexNode(node, filePath);
    return node;
  }

  updateNode(
    id: string,
    updates: Partial<
      Pick<MemoryNode, "title" | "type" | "status" | "content" | "links">
    >
  ): MemoryNode | null {
    const filePath = path.join(this.nodesDir, `${id}.md`);
    const node = this.markdownToNode(filePath);
    if (!node) return null;

    if (updates.title !== undefined) node.title = updates.title;
    if (updates.type !== undefined) node.type = updates.type;
    if (updates.status !== undefined) node.status = updates.status;
    if (updates.content !== undefined) node.content = updates.content;
    if (updates.links !== undefined) node.links = updates.links;
    node.updated = new Date().toISOString();

    fs.writeFileSync(filePath, this.nodeToMarkdown(node), "utf-8");
    this.indexNode(node, filePath);
    return node;
  }

  getNode(id: string): MemoryNode | null {
    const filePath = path.join(this.nodesDir, `${id}.md`);
    return this.markdownToNode(filePath);
  }

  // ── Edge queries ────────────────────────────────────────────

  private static readonly EDGE_WEIGHTS: Record<string, number> = {
    depends_on: 0.9,
    part_of: 0.85,
    relates_to: 0.5,
    supersedes: 0.3,
  };

  getNodeNeighbors(
    id: string
  ): Array<{ node: MemoryNode; edgeType: string; weight: number }> {
    // Explicit edges
    const explicit = this.db
      .prepare(
        `SELECT DISTINCT n.id, e.type AS edge_type FROM nodes n
         JOIN edges e ON (e.target_id = n.id AND e.source_id = ?)
                      OR (e.source_id = n.id AND e.target_id = ?)
         WHERE n.status = 'active'`
      )
      .all(id, id) as { id: string; edge_type: string }[];

    // Derived edges
    const derived = this.db
      .prepare(
        `SELECT DISTINCT n.id, d.type AS edge_type, d.strength FROM nodes n
         JOIN derived_edges d ON (d.target_id = n.id AND d.source_id = ?)
                              OR (d.source_id = n.id AND d.target_id = ?)
         WHERE n.status = 'active'`
      )
      .all(id, id) as { id: string; edge_type: string; strength: number }[];

    const seen = new Set<string>();
    const results: Array<{ node: MemoryNode; edgeType: string; weight: number }> = [];

    for (const row of explicit) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const node = this.getNode(row.id);
      if (node) {
        results.push({
          node,
          edgeType: row.edge_type,
          weight: Store.EDGE_WEIGHTS[row.edge_type] ?? 0.5,
        });
      }
    }

    for (const row of derived) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const node = this.getNode(row.id);
      if (node) {
        results.push({
          node,
          edgeType: row.edge_type,
          weight: (Store.EDGE_WEIGHTS[row.edge_type] ?? 0.5) * row.strength * 0.7,
        });
      }
    }

    return results;
  }

  getInDegree(id: string): number {
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

  private indexNode(node: MemoryNode, filePath: string): void {
    const preview = node.content.slice(0, 500);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO nodes
         (id, title, type, status, created, updated, content_preview, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        node.id,
        node.title,
        node.type,
        node.status,
        node.created,
        node.updated,
        preview,
        filePath
      );

    this.db.prepare("DELETE FROM edges WHERE source_id = ?").run(node.id);
    const insertEdge = this.db.prepare(
      "INSERT OR IGNORE INTO edges (source_id, target_id, type, created) VALUES (?, ?, ?, ?)"
    );
    for (const link of node.links) {
      insertEdge.run(node.id, link.target, link.type, node.updated);
    }
  }

  // ── Enrichment pipeline (Phase 2) ──────────────────────────

  async enrichNode(nodeId: string): Promise<void> {
    const node = this.getNode(nodeId);
    if (!node) return;

    const fullText = `${node.title}\n\n${node.content}`;

    // Extract and store entities
    const entities = extractEntities(fullText);
    this.db.prepare("DELETE FROM entities WHERE node_id = ?").run(nodeId);
    const insertEntity = this.db.prepare(
      "INSERT INTO entities (id, name, type, node_id) VALUES (?, ?, ?, ?)"
    );
    for (const ent of entities) {
      insertEntity.run(crypto.randomUUID(), ent.name, ent.type, nodeId);
    }

    // Extract and store claims
    const claims = extractClaims(fullText);
    this.db.prepare("DELETE FROM claims WHERE node_id = ?").run(nodeId);
    const insertClaim = this.db.prepare(
      "INSERT INTO claims (id, text, node_id) VALUES (?, ?, ?)"
    );
    for (const claim of claims) {
      insertClaim.run(crypto.randomUUID(), claim.text, nodeId);
    }

    // Generate and store embedding
    if (this.hasEmbeddings()) {
      const [vector] = await this.embedder!.embed([fullText]);
      if (vector.length > 0) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO embeddings (ref_type, ref_id, vector, model, dimensions)
             VALUES ('node', ?, ?, ?, ?)`
          )
          .run(nodeId, JSON.stringify(vector), this.embedder!.name, vector.length);
      }
    }

    // Derive edges from entity co-occurrence
    this.deriveEdgesForNode(nodeId, entities.map((e) => e.name));
  }

  private deriveEdgesForNode(nodeId: string, entityNames: string[]): void {
    if (entityNames.length === 0) return;

    this.db
      .prepare("DELETE FROM derived_edges WHERE source_id = ? AND type = 'relates_to'")
      .run(nodeId);

    // Find other nodes that share entities with this one
    const placeholders = entityNames.map(() => "?").join(",");
    const cooccurring = this.db
      .prepare(
        `SELECT DISTINCT e.node_id, e.name FROM entities e
         WHERE e.name IN (${placeholders}) AND e.node_id != ?`
      )
      .all(...entityNames, nodeId) as { node_id: string; name: string }[];

    // Group by node and count shared entities
    const sharedCounts = new Map<string, { count: number; names: string[] }>();
    for (const row of cooccurring) {
      const entry = sharedCounts.get(row.node_id) || { count: 0, names: [] };
      entry.count++;
      entry.names.push(row.name);
      sharedCounts.set(row.node_id, entry);
    }

    const insertDerived = this.db.prepare(
      `INSERT OR REPLACE INTO derived_edges
       (source_id, target_id, type, reason, strength, created)
       VALUES (?, ?, 'relates_to', ?, ?, ?)`
    );
    const now = new Date().toISOString();

    for (const [targetId, { count, names }] of sharedCounts) {
      const strength = Math.min(1.0, count / Math.max(entityNames.length, 1));
      insertDerived.run(
        nodeId,
        targetId,
        `shared entities: ${names.slice(0, 3).join(", ")}`,
        strength,
        now
      );
    }
  }

  // ── Search ──────────────────────────────────────────────────

  searchNodes(query: string, limit: number = 20): MemoryNode[] {
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((k) => k.length > 2);

    if (keywords.length === 0) {
      const rows = this.db
        .prepare(
          "SELECT id FROM nodes WHERE status = 'active' ORDER BY updated DESC LIMIT ?"
        )
        .all(limit) as { id: string }[];
      return rows
        .map((r) => this.getNode(r.id))
        .filter((n): n is MemoryNode => n !== null);
    }

    const allActive = this.db
      .prepare(
        "SELECT id, title, content_preview FROM nodes WHERE status = 'active'"
      )
      .all() as { id: string; title: string; content_preview: string }[];

    const scored = allActive
      .map((row) => {
        const text = `${row.title} ${row.content_preview}`.toLowerCase();
        let score = 0;
        for (const k of keywords) {
          if (text.includes(k)) score++;
        }
        return { id: row.id, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored
      .map((s) => this.getNode(s.id))
      .filter((n): n is MemoryNode => n !== null);
  }

  async semanticSearch(
    query: string,
    limit: number = 20
  ): Promise<Array<{ node: MemoryNode; similarity: number }>> {
    if (!this.hasEmbeddings()) return [];

    const [queryVec] = await this.embedder!.embed([query]);
    if (queryVec.length === 0) return [];

    const allEmbeddings = this.db
      .prepare(
        `SELECT e.ref_id, e.vector FROM embeddings e
         JOIN nodes n ON n.id = e.ref_id
         WHERE e.ref_type = 'node' AND n.status = 'active'`
      )
      .all() as { ref_id: string; vector: string }[];

    const scored = allEmbeddings
      .map((row) => {
        const vec = JSON.parse(row.vector) as number[];
        return { id: row.ref_id, similarity: cosine(queryVec, vec) };
      })
      .filter((s) => s.similarity > 0.1)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return scored
      .map((s) => {
        const node = this.getNode(s.id);
        return node ? { node, similarity: s.similarity } : null;
      })
      .filter((r): r is { node: MemoryNode; similarity: number } => r !== null);
  }

  findNodesByEntity(entityName: string): MemoryNode[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.node_id FROM entities e
         JOIN nodes n ON n.id = e.node_id
         WHERE LOWER(e.name) = LOWER(?) AND n.status = 'active'`
      )
      .all(entityName) as { node_id: string }[];

    return rows
      .map((r) => this.getNode(r.node_id))
      .filter((n): n is MemoryNode => n !== null);
  }

  getNodeEntities(nodeId: string): Array<{ name: string; type: string }> {
    return this.db
      .prepare("SELECT name, type FROM entities WHERE node_id = ?")
      .all(nodeId) as Array<{ name: string; type: string }>;
  }

  // ── Commit task (atomic) ────────────────────────────────────

  commitTask(
    sessionId: string,
    residue: TaskResidue
  ): { nodes: MemoryNode[] } {
    const created: MemoryNode[] = [];

    const run = this.db.transaction(() => {
      for (const input of residue.nodes) {
        if (input.id) {
          const updated = this.updateNode(input.id, {
            title: input.title,
            type: input.type,
            content: input.content,
            links: input.links,
          });
          if (updated) created.push(updated);
        } else {
          created.push(
            this.createNode({
              title: input.title,
              type: input.type,
              content: input.content,
              links: input.links,
            })
          );
        }
      }
    });
    run();

    this.archiveScratchpad(sessionId);
    this.clearScratchpad(sessionId);

    return { nodes: created };
  }

  async enrichAfterCommit(nodeIds: string[]): Promise<void> {
    for (const id of nodeIds) {
      await this.enrichNode(id);
    }
  }

  // ── Snapshots ───────────────────────────────────────────────

  recordSnapshot(record: SnapshotRecord): void {
    this.db
      .prepare(
        "INSERT INTO snapshots (session_id, reason, snapshot_path, timestamp) VALUES (?, ?, ?, ?)"
      )
      .run(record.session_id, record.reason, record.snapshot, record.timestamp);
  }

  // ── Index rebuild ───────────────────────────────────────────

  rebuildIndex(): number {
    this.db.exec(
      "DELETE FROM nodes; DELETE FROM edges; DELETE FROM entities; DELETE FROM claims; DELETE FROM embeddings; DELETE FROM derived_edges;"
    );
    let count = 0;
    const files = fs
      .readdirSync(this.nodesDir)
      .filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = path.join(this.nodesDir, file);
      const node = this.markdownToNode(filePath);
      if (node) {
        this.indexNode(node, filePath);
        count++;
      }
    }
    return count;
  }

  async rebuildEnrichments(): Promise<number> {
    const rows = this.db
      .prepare("SELECT id FROM nodes WHERE status = 'active'")
      .all() as { id: string }[];
    for (const row of rows) {
      await this.enrichNode(row.id);
    }
    return rows.length;
  }

  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
