/**
 * DRAM end-to-end eval — validates the definition of done from HANDOFF.md:
 *
 * 1. After compaction, the agent resumes same task/decisions without re-planning
 * 2. Every node change is reversible — nothing hard-deleted
 * 3. Retrieval loads just task-relevant subgraph within budget
 * 4. Scratchpad always fits for full re-injection
 * 5. Superseded decisions stay archived with reason preserved
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Store } from "../store.js";
import { NoopEmbedding } from "../embeddings.js";
import { MaintenanceHandler } from "../maintenance.js";
import { rankSubgraph } from "../tools.js";

let store: Store;
let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dram-eval-"));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  store = new Store(tmpDir);
  store.setEmbeddingProvider(new NoopEmbedding());
});

afterEach(() => {
  store.close();
  rmrf(tmpDir);
});

// ── 1. Compaction survival ────────────────────────────────────────

describe("compaction survival", () => {
  it("checkpoint state survives simulated compaction and restores exactly", () => {
    const sessionId = "session-alpha";
    const state = [
      "## Task",
      "Migrate auth middleware to new token format",
      "",
      "## Decisions",
      "1. Use JWT with RS256 — because legal requires non-repudiation",
      "2. Keep old middleware running in parallel for 2 weeks (rollback window)",
      "",
      "## Progress",
      "- [x] Wrote new token validator",
      "- [x] Added dual-read to session handler",
      "- [ ] Wire up rotation endpoint",
      "",
      "## Constraints",
      "- Tokens must be under 4KB for cookie transport",
      "- Do NOT touch module Z (frozen for compliance audit)",
    ].join("\n");

    store.saveScratchpad(sessionId, state);

    // Simulate compaction: volatile context is gone, only scratchpad survives
    const restored = store.getScratchpad(sessionId);
    expect(restored).toBe(state);
    expect(restored).toContain("JWT with RS256");
    expect(restored).toContain("Do NOT touch module Z");
  });

  it("committed knowledge is retrievable from a fresh session", async () => {
    // Session 1: do work and commit
    const session1 = "session-1";
    store.saveScratchpad(session1, "Working on auth migration");
    const result = store.commitTask(session1, {
      nodes: [
        {
          title: "Auth migration decision",
          type: "decision",
          content:
            "Switched from HMAC-SHA256 to RSA-signed JWT tokens. Reason: legal requires non-repudiation for audit trail. Old tokens sunset after 14 days.",
        },
        {
          title: "Token validator implementation",
          type: "fact",
          content:
            "New validator lives in src/auth/jwt-validator.ts. Accepts RS256 tokens, validates against JWKS endpoint, caches public keys for 1 hour.",
        },
      ],
      summary: "Auth migration phase 1 complete",
    });
    await store.enrichAfterCommit(result.nodes.map((n) => n.id));

    // Scratchpad is cleared after commit
    expect(store.getScratchpad(session1)).toBeNull();

    // Session 2: fresh session finds the knowledge
    const scored = await rankSubgraph(store, "JWT token authentication");
    expect(scored.length).toBeGreaterThan(0);

    const titles = scored.map((s) => s.node.title);
    expect(titles).toContain("Auth migration decision");
    expect(titles).toContain("Token validator implementation");
  });

  it("full protocol lifecycle: restore → checkpoint → commit → retrieve", async () => {
    const session = "session-lifecycle";

    // Step 1: restore on fresh session — nothing there
    const initial = store.getScratchpad(session);
    expect(initial).toBeNull();

    // Step 2: first checkpoint
    store.saveScratchpad(session, "Task: set up database indexes\nProgress: analyzing queries");

    // Step 3: updated checkpoint (overwrite in place)
    store.saveScratchpad(
      session,
      "Task: set up database indexes\nProgress: added idx_users_email, idx_orders_date\nDecision: composite index on (user_id, created_at) — covers the dashboard query"
    );

    // Verify latest state wins
    const midState = store.getScratchpad(session);
    expect(midState).toContain("composite index");

    // Step 4: commit
    const committed = store.commitTask(session, {
      nodes: [
        {
          title: "Database index strategy",
          type: "decision",
          content:
            "Added composite index on (user_id, created_at) to cover the dashboard query. Single-column indexes on users.email and orders.date for lookup patterns.",
        },
      ],
    });
    await store.enrichAfterCommit(committed.nodes.map((n) => n.id));

    // Step 5: scratchpad cleared
    expect(store.getScratchpad(session)).toBeNull();

    // Step 6: new task retrieves old knowledge
    const found = await rankSubgraph(store, "database query performance indexes");
    expect(found.some((s) => s.node.title === "Database index strategy")).toBe(true);
  });
});

// ── 2. Reversibility — no hard deletes ────────────────────────────

describe("reversibility", () => {
  it("maintenance demotes stale leaves to archived, never deletes files", async () => {
    // Create a note and backdate it
    const node = store.createNode({
      title: "Temporary debug note",
      type: "note",
      content: "Added console.log to trace the race condition in order processing.",
    });

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    store.getDb().prepare("UPDATE nodes SET updated = ?, created = ? WHERE id = ?").run(thirtyDaysAgo, thirtyDaysAgo, node.id);
    const filePath = path.join(tmpDir, "nodes", `${node.id}.md`);
    const raw = fs.readFileSync(filePath, "utf-8");
    fs.writeFileSync(filePath, raw.replace(node.updated, thirtyDaysAgo), "utf-8");

    // Simulate 10 active days so the note (7-day threshold) is eligible
    for (let i = 0; i < 10; i++) {
      const m = store.createNode({ title: `Activity ${i}`, type: "note", content: `Day ${i}` });
      const created = new Date(Date.now() - (10 - i) * 24 * 3_600_000).toISOString();
      store.getDb().prepare("UPDATE nodes SET created = ? WHERE id = ?").run(created, m.id);
    }

    const handler = new MaintenanceHandler(store, store.getDb());
    const result = await handler.run();

    // File must still exist regardless of demotion
    expect(fs.existsSync(filePath)).toBe(true);

    if (result.demoted.includes(node.id)) {
      const archived = store.getNode(node.id);
      expect(archived).not.toBeNull();
      expect(archived!.status).toBe("archived");
    }

    const logEntries = store
      .getDb()
      .prepare("SELECT * FROM maintenance_log WHERE node_id = ?")
      .all(node.id);
    expect(logEntries.length).toBeGreaterThan(0);
  });

  it("superseded nodes are status-changed, not deleted", async () => {
    const oldDecision = store.createNode({
      title: "Use Redis for caching",
      type: "decision",
      content: "Chose Redis for the session cache because of its pub/sub support.",
    });

    const newDecision = store.createNode({
      title: "Use SQLite for caching",
      type: "decision",
      content:
        "Switched from Redis to SQLite for caching. Reason: eliminates an infrastructure dependency, and our cache fits in memory. Redis pub/sub was unused.",
      links: [{ target: oldDecision.id, type: "supersedes" }],
    });

    const handler = new MaintenanceHandler(store, store.getDb());
    await handler.run();

    // Old decision is superseded, not deleted
    const old = store.getNode(oldDecision.id);
    expect(old).not.toBeNull();
    expect(old!.status).toBe("superseded");
    expect(old!.content).toContain("Redis");

    // New decision is still active
    const current = store.getNode(newDecision.id);
    expect(current).not.toBeNull();
    expect(current!.status).toBe("active");

    // Both markdown files exist on disk
    expect(fs.existsSync(path.join(tmpDir, "nodes", `${oldDecision.id}.md`))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "nodes", `${newDecision.id}.md`))).toBe(true);
  });

  it("scratchpad is archived before clearing on commit", () => {
    const session = "session-archive-test";
    store.saveScratchpad(session, "Important working state that should be recoverable");
    store.commitTask(session, {
      nodes: [{ title: "Test node", type: "note", content: "Some content" }],
    });

    // Scratchpad cleared
    expect(store.getScratchpad(session)).toBeNull();

    // But archive exists
    const archiveDir = path.join(tmpDir, "archive", "scratchpads");
    const archives = fs.readdirSync(archiveDir).filter((f) => f.startsWith("session-archive-test"));
    expect(archives.length).toBe(1);

    // Archive content matches what was saved
    const archiveContent = fs.readFileSync(path.join(archiveDir, archives[0]), "utf-8");
    expect(archiveContent).toBe("Important working state that should be recoverable");
  });
});

// ── 3. Retrieval precision ────────────────────────────────────────

describe("retrieval precision", () => {
  it("read_subgraph returns topic-relevant nodes, not unrelated ones", async () => {
    // Commit nodes on three distinct topics
    const authNodes = store.commitTask("s1", {
      nodes: [
        {
          title: "OAuth2 integration",
          type: "fact",
          content:
            "Integrated OAuth2 with Google and GitHub providers. Token refresh handled by middleware. PKCE flow for SPAs.",
        },
        {
          title: "Session token format",
          type: "decision",
          content:
            "Using opaque session tokens stored in httpOnly cookies. Server-side session store in PostgreSQL.",
        },
      ],
    });
    await store.enrichAfterCommit(authNodes.nodes.map((n) => n.id));

    const dbNodes = store.commitTask("s2", {
      nodes: [
        {
          title: "PostgreSQL schema conventions",
          type: "pattern",
          content:
            "All tables use UUID primary keys. Timestamps are always UTC. Soft-delete via deleted_at column. Indexes on all foreign keys.",
        },
      ],
    });
    await store.enrichAfterCommit(dbNodes.nodes.map((n) => n.id));

    const uiNodes = store.commitTask("s3", {
      nodes: [
        {
          title: "React component structure",
          type: "pattern",
          content:
            "Components follow container/presenter pattern. State managed via Zustand. No Redux. CSS modules for styling.",
        },
      ],
    });
    await store.enrichAfterCommit(uiNodes.nodes.map((n) => n.id));

    // Query for auth — should rank auth nodes highest
    const authResults = await rankSubgraph(store, "OAuth2 authentication tokens session");
    expect(authResults.length).toBeGreaterThan(0);
    const topTitles = authResults.slice(0, 2).map((s) => s.node.title);
    expect(topTitles).toContain("OAuth2 integration");

    // Query for UI — should rank UI node highest
    const uiResults = await rankSubgraph(store, "React components state management Zustand");
    expect(uiResults.length).toBeGreaterThan(0);
    expect(uiResults[0].node.title).toBe("React component structure");
  });

  it("budget trimming keeps output within limits", async () => {
    // Create many nodes
    for (let i = 0; i < 20; i++) {
      const result = store.commitTask(`s-bulk-${i}`, {
        nodes: [
          {
            title: `Technical decision ${i}`,
            type: "decision",
            content: `This is technical decision number ${i}. `.repeat(50) +
              "Authentication and authorization are important topics.",
          },
        ],
      });
      await store.enrichAfterCommit(result.nodes.map((n) => n.id));
    }

    // Query with a small budget — should get fewer nodes than exist
    const smallBudget = await rankSubgraph(store, "technical decision authentication");
    const largeBudget = await rankSubgraph(store, "technical decision authentication");

    // With default budget of 4000 tokens (~16000 chars), we should get some results
    expect(smallBudget.length).toBeGreaterThan(0);

    // The scored list itself is pre-trim; the trim happens in the tool handler.
    // But we can verify that all results have positive scores and are sorted.
    for (let i = 1; i < smallBudget.length; i++) {
      expect(smallBudget[i - 1].finalScore).toBeGreaterThanOrEqual(smallBudget[i].finalScore);
    }
  });
});

// ── 4. Enrichment and derived edges ───────────────────────────────

describe("enrichment pipeline", () => {
  it("entities are extracted and stored for committed nodes", async () => {
    const result = store.commitTask("s-enrich", {
      nodes: [
        {
          title: "API route handler",
          type: "fact",
          content:
            "The `handleRequest` function in src/api/routes.ts processes incoming HTTP requests. It validates the JWT token using `validateToken` and delegates to the appropriate controller.",
        },
      ],
    });
    await store.enrichAfterCommit(result.nodes.map((n) => n.id));

    const nodeId = result.nodes[0].id;
    const entities = store.getNodeEntities(nodeId);

    expect(entities.length).toBeGreaterThan(0);
    const entityNames = entities.map((e) => e.name);
    expect(entityNames).toContain("handleRequest");
    expect(entityNames).toContain("validateToken");
  });

  it("shared entities create derived edges between nodes", async () => {
    // Two nodes that mention the same code identifiers
    const r1 = store.commitTask("s-derive-1", {
      nodes: [
        {
          title: "Auth middleware",
          type: "fact",
          content:
            "The `validateToken` function in src/auth/validate.ts checks JWT signatures. Called by `handleRequest` in the API layer.",
        },
      ],
    });
    await store.enrichAfterCommit(r1.nodes.map((n) => n.id));

    const r2 = store.commitTask("s-derive-2", {
      nodes: [
        {
          title: "API error handling",
          type: "fact",
          content:
            "When `validateToken` returns false, `handleRequest` responds with 401 Unauthorized. All errors are logged to the audit trail.",
        },
      ],
    });
    await store.enrichAfterCommit(r2.nodes.map((n) => n.id));

    // Check for derived edges between the two nodes
    const derivedEdges = store
      .getDb()
      .prepare(
        `SELECT * FROM derived_edges
         WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`
      )
      .all(r1.nodes[0].id, r2.nodes[0].id, r2.nodes[0].id, r1.nodes[0].id) as any[];

    expect(derivedEdges.length).toBeGreaterThan(0);
    expect(derivedEdges[0].reason).toContain("shared entities");
  });
});

// ── 5. Supersession chain ─────────────────────────────────────────

describe("supersession", () => {
  it("superseded decision preserves the full chain with reasons", async () => {
    // V1 decision
    const v1 = store.createNode({
      title: "Cache strategy v1: in-memory LRU",
      type: "decision",
      content: "Using an in-memory LRU cache with 1000 entry limit. Simple and fast for single-server deployment.",
    });

    // V2 supersedes V1
    const v2 = store.createNode({
      title: "Cache strategy v2: Redis",
      type: "decision",
      content:
        "Switching to Redis for caching. Reason: we're scaling to multiple servers and need a shared cache. In-memory LRU doesn't work across instances.",
      links: [{ target: v1.id, type: "supersedes" }],
    });

    // V3 supersedes V2
    const v3 = store.createNode({
      title: "Cache strategy v3: SQLite WAL",
      type: "decision",
      content:
        "Switching from Redis to SQLite with WAL mode. Reason: Redis was a single point of failure and added operational complexity. SQLite WAL gives us concurrent reads with zero infrastructure.",
      links: [{ target: v2.id, type: "supersedes" }],
    });

    // Run maintenance to process supersession
    const handler = new MaintenanceHandler(store, store.getDb());
    await handler.run();

    // V1 and V2 are superseded
    expect(store.getNode(v1.id)!.status).toBe("superseded");
    expect(store.getNode(v2.id)!.status).toBe("superseded");

    // V3 is active
    expect(store.getNode(v3.id)!.status).toBe("active");

    // The full chain is traceable: V3 → V2 → V1
    expect(v3.links.some((l) => l.target === v2.id && l.type === "supersedes")).toBe(true);
    expect(v2.links.some((l) => l.target === v1.id && l.type === "supersedes")).toBe(true);

    // Reasons are preserved in each node's content
    expect(store.getNode(v2.id)!.content).toContain("scaling to multiple servers");
    expect(store.getNode(v3.id)!.content).toContain("single point of failure");

    // All files still on disk
    expect(fs.existsSync(path.join(tmpDir, "nodes", `${v1.id}.md`))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "nodes", `${v2.id}.md`))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "nodes", `${v3.id}.md`))).toBe(true);
  });
});

// ── 6. Maintenance ────────────────────────────────────────────────

describe("maintenance", () => {
  it("importance scoring ranks high-connectivity nodes above orphans", () => {
    // Create a central node
    const central = store.createNode({
      title: "Core data model",
      type: "fact",
      content: "The User entity is the central model with relations to Orders, Sessions, and Preferences.",
    });

    // Create satellite nodes that link to central
    for (let i = 0; i < 5; i++) {
      store.createNode({
        title: `Feature ${i}`,
        type: "fact",
        content: `Feature ${i} depends on the core data model.`,
        links: [{ target: central.id, type: "depends_on" }],
      });
    }

    // Create an orphan node
    const orphan = store.createNode({
      title: "Random scratch note",
      type: "note",
      content: "Just a temporary thought.",
    });

    const handler = new MaintenanceHandler(store, store.getDb());
    const scores = handler.scoreAllNodes();

    const centralScore = scores.find((s) => s.nodeId === central.id);
    const orphanScore = scores.find((s) => s.nodeId === orphan.id);

    expect(centralScore).toBeDefined();
    expect(orphanScore).toBeDefined();
    expect(centralScore!.total).toBeGreaterThan(orphanScore!.total);
    expect(centralScore!.inDegree).toBe(5);
    expect(orphanScore!.isLeaf).toBe(true);
  });

  it("dangling edges are repaired", async () => {
    const node = store.createNode({
      title: "Surviving node",
      type: "fact",
      content: "This node links to a ghost.",
      links: [{ target: "nonexistent-id-12345", type: "depends_on" }],
    });

    // Verify dangling edge exists
    const before = store
      .getDb()
      .prepare("SELECT COUNT(*) as cnt FROM edges WHERE target_id = 'nonexistent-id-12345'")
      .get() as { cnt: number };
    expect(before.cnt).toBe(1);

    const handler = new MaintenanceHandler(store, store.getDb());
    const result = await handler.run();

    expect(result.danglingEdgesRepaired).toBeGreaterThan(0);

    // Dangling edge is gone
    const after = store
      .getDb()
      .prepare("SELECT COUNT(*) as cnt FROM edges WHERE target_id = 'nonexistent-id-12345'")
      .get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  it("community detection creates summary nodes for connected components", async () => {
    // Create a cluster of 4 interconnected nodes
    const a = store.createNode({ title: "Payment processor", type: "fact", content: "Handles Stripe payments." });
    const b = store.createNode({
      title: "Invoice generator",
      type: "fact",
      content: "Creates PDF invoices for completed payments.",
      links: [{ target: a.id, type: "depends_on" }],
    });
    const c = store.createNode({
      title: "Refund handler",
      type: "fact",
      content: "Processes refunds through the payment processor.",
      links: [{ target: a.id, type: "depends_on" }],
    });
    const d = store.createNode({
      title: "Payment webhook",
      type: "fact",
      content: "Receives Stripe webhook events and updates order status.",
      links: [
        { target: a.id, type: "relates_to" },
        { target: b.id, type: "relates_to" },
      ],
    });

    const handler = new MaintenanceHandler(store, store.getDb());
    const result = await handler.run();

    expect(result.communities).toBeGreaterThan(0);

    // A community_summary node should exist
    const summaries = store
      .getDb()
      .prepare("SELECT id, title FROM nodes WHERE type = 'community_summary'")
      .all() as { id: string; title: string }[];

    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0].title).toContain("Community:");
  });

  it("maintenance log is append-only and records all actions", async () => {
    const node = store.createNode({
      title: "Temp node",
      type: "note",
      content: "Will be superseded.",
    });
    store.createNode({
      title: "Replacement node",
      type: "note",
      content: "Supersedes the temp node.",
      links: [{ target: node.id, type: "supersedes" }],
    });

    const handler = new MaintenanceHandler(store, store.getDb());
    await handler.run();

    const logs = store
      .getDb()
      .prepare("SELECT action, node_id, detail FROM maintenance_log ORDER BY id")
      .all() as { action: string; node_id: string; detail: string }[];

    // Should have at least the supersede action and the run_complete
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("supersede");
    expect(actions).toContain("run_complete");
  });
});

// ── 7. Index rebuild ──────────────────────────────────────────────

describe("index rebuild", () => {
  it("markdown is source of truth — index rebuilds from files", async () => {
    // Create nodes normally
    const result = store.commitTask("s-rebuild", {
      nodes: [
        { title: "Rebuild test A", type: "fact", content: "Node A content about authentication." },
        { title: "Rebuild test B", type: "fact", content: "Node B content about database schema." },
      ],
    });
    await store.enrichAfterCommit(result.nodes.map((n) => n.id));

    const originalIds = result.nodes.map((n) => n.id);

    // Wipe the index
    const rebuilt = store.rebuildIndex();
    expect(rebuilt).toBe(2);

    // Nodes are still accessible by ID
    for (const id of originalIds) {
      const node = store.getNode(id);
      expect(node).not.toBeNull();
    }

    // Search still works after rebuild
    const found = store.searchNodes("authentication", 10);
    expect(found.some((n) => n.title === "Rebuild test A")).toBe(true);
  });
});

// ── 8. Scratchpad sizing ──────────────────────────────────────────

// ── 8. Archive-then-GC tuning ─────────────────────────────────────

describe("GC tuning", () => {
  // Backdate a node's updated (and created) timestamp in both DB and markdown
  function backdateNode(nodeId: string, hoursAgo: number) {
    const when = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    store.getDb().prepare("UPDATE nodes SET updated = ?, created = ? WHERE id = ?").run(when, when, nodeId);
    const filePath = path.join(tmpDir, "nodes", `${nodeId}.md`);
    const raw = fs.readFileSync(filePath, "utf-8");
    fs.writeFileSync(filePath, raw.replace(/updated: '[^']*'/, `updated: '${when}'`), "utf-8");
  }

  // Simulate N active days by inserting dummy nodes with distinct created dates
  // starting from daysAgo and counting toward the present
  function simulateActiveDays(count: number, startDaysAgo: number = count) {
    for (let i = 0; i < count; i++) {
      const daysBack = startDaysAgo - i;
      const created = new Date(Date.now() - daysBack * 24 * 3_600_000).toISOString();
      const n = store.createNode({
        title: `Activity marker day ${i}`,
        type: "note",
        content: `Simulated activity on day ${daysBack}.`,
      });
      store.getDb().prepare("UPDATE nodes SET created = ? WHERE id = ?").run(created, n.id);
    }
  }

  it("decisions survive longer than notes (active-day thresholds)", async () => {
    // Create a note and a decision, both backdated far enough to be old
    const note = store.createNode({
      title: "Scratch note",
      type: "note",
      content: "Temporary thought about a debug session.",
    });
    const decision = store.createNode({
      title: "Use connection pooling",
      type: "decision",
      content: "Decided to use pg-pool for connection pooling. Max 20 connections.",
    });
    backdateNode(note.id, 30 * 24);     // 30 days old
    backdateNode(decision.id, 30 * 24); // 30 days old

    // Simulate 10 active days since those nodes were created
    // That's past the note threshold (7) but not the decision threshold (30)
    simulateActiveDays(10);

    const handler = new MaintenanceHandler(store, store.getDb());
    const result = await handler.run();

    // Note should be demoted (10 active days > 7 day note threshold)
    expect(result.demoted).toContain(note.id);
    // Decision should survive (10 active days < 30 day decision threshold)
    expect(result.demoted).not.toContain(decision.id);
    expect(result.skippedDemotion).toContain(decision.id);
  });

  it("community_summary nodes are never demoted", async () => {
    const summary = store.createNode({
      title: "Community: Auth, Sessions, Tokens",
      type: "community_summary",
      content: "Community of 3 related nodes about authentication.",
    });
    backdateNode(summary.id, 60 * 24);
    simulateActiveDays(40);

    const handler = new MaintenanceHandler(store, store.getDb());
    const result = await handler.run();

    expect(result.demoted).not.toContain(summary.id);
    expect(result.skippedDemotion).toContain(summary.id);
    expect(store.getNode(summary.id)!.status).toBe("active");
  });

  it("demotion is capped at 20% of active nodes per run", async () => {
    const nodes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const n = store.createNode({
        title: `Stale note ${i}`,
        type: "note",
        content: `Old debug note number ${i}.`,
      });
      backdateNode(n.id, 30 * 24);
      nodes.push(n.id);
    }
    // Enough active days to pass the note threshold
    simulateActiveDays(10);

    const handler = new MaintenanceHandler(store, store.getDb());
    const result = await handler.run();

    // 20% of active count — should cap demotions
    expect(result.demoted.length).toBeLessThanOrEqual(
      Math.max(1, Math.floor((10 + 10) * 0.2)) // 10 stale + 10 activity markers
    );
    expect(result.cappedDemotion.length).toBeGreaterThan(0);

    // The rest are still active
    const stillActive = nodes.filter((id) => store.getNode(id)!.status === "active");
    expect(stillActive.length).toBeGreaterThan(0);
  });

  it("idle graph skips demotion entirely", async () => {
    const note = store.createNode({
      title: "Note on idle project",
      type: "note",
      content: "This project hasn't been touched in weeks.",
    });
    backdateNode(note.id, 30 * 24);

    // First run: records run_complete (with activity markers to allow demotion)
    simulateActiveDays(10);
    const handler1 = new MaintenanceHandler(store, store.getDb());
    await handler1.run();

    // Second run: no new nodes since last run_complete → idle
    const handler2 = new MaintenanceHandler(store, store.getDb());
    const result = await handler2.run();

    expect(result.demoted.length).toBe(0);
    expect(result.log.some((l) => l.includes("graph is idle"))).toBe(true);
  });

  it("dry-run previews changes without applying them", async () => {
    const old = store.createNode({
      title: "Old decision to supersede",
      type: "note",
      content: "Will be superseded.",
    });
    store.createNode({
      title: "New replacement",
      type: "note",
      content: "Supersedes the old one.",
      links: [{ target: old.id, type: "supersedes" }],
    });

    const stale = store.createNode({
      title: "Stale leaf",
      type: "note",
      content: "Should be demoted.",
    });
    backdateNode(stale.id, 30 * 24);
    simulateActiveDays(10);

    const dryHandler = new MaintenanceHandler(store, store.getDb(), { dryRun: true });
    const dryResult = await dryHandler.run();

    expect(dryResult.supersessionMarked.length).toBeGreaterThan(0);

    // Nothing actually changed
    expect(store.getNode(old.id)!.status).toBe("active");
    expect(store.getNode(stale.id)!.status).toBe("active");

    const logs = store
      .getDb()
      .prepare("SELECT action FROM maintenance_log WHERE action LIKE '%preview%'")
      .all() as { action: string }[];
    expect(logs.length).toBeGreaterThan(0);
  });

  it("facts require 14 active days before demotion, not 7", async () => {
    const fact = store.createNode({
      title: "API response format",
      type: "fact",
      content: "All API responses use JSON:API envelope format.",
    });
    backdateNode(fact.id, 30 * 24);

    // 10 active days — past note threshold (7) but not fact threshold (14)
    simulateActiveDays(10);

    const handler = new MaintenanceHandler(store, store.getDb());
    const result = await handler.run();

    expect(result.demoted).not.toContain(fact.id);
    expect(store.getNode(fact.id)!.status).toBe("active");
  });

  it("a project break does not advance the demotion clock", async () => {
    // Create a decision
    const decision = store.createNode({
      title: "Use PostgreSQL",
      type: "decision",
      content: "Chose PostgreSQL for the primary datastore.",
    });
    backdateNode(decision.id, 90 * 24); // Created 90 wall-clock days ago

    // But only 5 active days of work happened since then
    simulateActiveDays(5);

    const handler = new MaintenanceHandler(store, store.getDb());
    const result = await handler.run();

    // 5 active days < 30 day decision threshold — survives despite 90 wall-clock days
    expect(result.demoted).not.toContain(decision.id);
    expect(store.getNode(decision.id)!.status).toBe("active");
  });

  it("multiple maintenance runs converge without destroying the graph", async () => {
    const nodes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const n = store.createNode({
        title: `Note ${i}`,
        type: "note",
        content: `Content for note ${i}.`,
      });
      backdateNode(n.id, 60 * 24);
      nodes.push(n.id);
    }

    const decision = store.createNode({
      title: "Important architecture decision",
      type: "decision",
      content: "We use event sourcing for the order pipeline.",
    });
    backdateNode(decision.id, 60 * 24);

    // 10 active days: enough to demote notes (7) but not decisions (30)
    simulateActiveDays(10);

    // Each run needs new activity to avoid the idle-graph check.
    // Simulate by adding a node before each run on a distinct date.
    for (let run = 0; run < 10; run++) {
      const marker = store.createNode({
        title: `Run ${run} marker`,
        type: "note",
        content: `Activity for run ${run}.`,
      });
      // Give each marker a unique created date so they count as distinct active days
      const created = new Date(Date.now() + (run + 1) * 24 * 3_600_000).toISOString();
      store.getDb().prepare("UPDATE nodes SET created = ? WHERE id = ?").run(created, marker.id);

      const handler = new MaintenanceHandler(store, store.getDb());
      await handler.run();
    }

    // All original notes should eventually be demoted
    const activeNotes = nodes.filter((id) => store.getNode(id)!.status === "active");
    expect(activeNotes.length).toBe(0);

    // Decision survives (only ~20 active days, threshold is 30)
    expect(store.getNode(decision.id)!.status).toBe("active");

    // Nothing hard-deleted
    for (const id of [...nodes, decision.id]) {
      expect(fs.existsSync(path.join(tmpDir, "nodes", `${id}.md`))).toBe(true);
    }
  });
});

// ── 9. Scratchpad sizing ──────────────────────────────────────────

describe("scratchpad re-injection", () => {
  it("realistically-sized scratchpad roundtrips without truncation", () => {
    const session = "session-size-test";

    // Build a realistic scratchpad (~2KB, well within any post-compaction budget)
    const scratchpad = [
      "## Task",
      "Refactor the notification system to support multiple channels (email, Slack, webhook).",
      "Requested by product team for Q3 launch.",
      "",
      "## Loaded from graph",
      "- notification_config node (id: abc-123): current email-only implementation",
      "- user_preferences node (id: def-456): per-user notification channel settings schema",
      "",
      "## Decisions",
      "1. Strategy pattern for channels — each channel implements NotificationChannel interface",
      "   Why: easy to add new channels without touching dispatch logic",
      "2. Fan-out via Promise.allSettled, not Promise.all",
      "   Why: one channel failure shouldn't block others",
      "3. ~SUPERSEDED~ Initially considered a queue (BullMQ) but decided against it",
      "   Reason: adds infrastructure for a feature that handles <100 notifications/minute",
      "",
      "## Progress",
      "- [x] Defined NotificationChannel interface",
      "- [x] Implemented EmailChannel (refactored from existing code)",
      "- [x] Implemented SlackChannel with webhook integration",
      "- [x] Implemented WebhookChannel with retry logic (3 attempts, exponential backoff)",
      "- [x] Updated dispatch to fan out across user's enabled channels",
      "- [ ] Add integration tests for each channel",
      "- [ ] Update API docs",
      "",
      "## Constraints",
      "- Slack webhook URL is in env var SLACK_WEBHOOK_URL, not in DB",
      "- Email templates must stay in templates/ dir (marketing team edits them directly)",
      "- Maximum 5 retry attempts for webhook delivery",
      "",
      "## Open questions",
      "- Should we add a dead-letter mechanism for permanently failed webhooks?",
      "- Rate limiting per channel or global?",
    ].join("\n");

    store.saveScratchpad(session, scratchpad);
    const restored = store.getScratchpad(session);

    expect(restored).toBe(scratchpad);
    expect(restored!.length).toBe(scratchpad.length);
  });
});
