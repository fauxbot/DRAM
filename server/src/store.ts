import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import crypto from "crypto";
import type { MemoryNode, NodeLink, TaskResidue, SnapshotRecord } from "./types.js";

export class Store {
  private db: Database.Database;
  private dataDir: string;
  private scratchpadDir: string;
  private nodesDir: string;
  private archiveDir: string;

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

    for (const dir of [
      this.scratchpadDir,
      this.nodesDir,
      this.archiveDir,
    ]) {
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

      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
      CREATE INDEX IF NOT EXISTS idx_nodes_updated ON nodes(updated);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);
    `);
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

  getNodeNeighbors(id: string): MemoryNode[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT n.id FROM nodes n
         JOIN edges e ON (e.target_id = n.id AND e.source_id = ?)
                      OR (e.source_id = n.id AND e.target_id = ?)
         WHERE n.status = 'active'`
      )
      .all(id, id) as { id: string }[];
    return rows
      .map((r) => this.getNode(r.id))
      .filter((n): n is MemoryNode => n !== null);
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

  // ── Search (Phase 1: keyword) ───────────────────────────────

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

    // Archive then clear — outside the SQLite transaction because these are
    // file operations, but ordered so the scratchpad is never lost before the
    // nodes are written (the transaction above already committed).
    this.archiveScratchpad(sessionId);
    this.clearScratchpad(sessionId);

    return { nodes: created };
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
    this.db.exec("DELETE FROM nodes; DELETE FROM edges;");
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

  close(): void {
    this.db.close();
  }
}
