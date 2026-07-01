export interface NodeLink {
  target: string;
  type: "depends_on" | "part_of" | "supersedes" | "relates_to";
}

export interface MemoryNode {
  id: string;
  title: string;
  type: string;
  status: "active" | "archived" | "superseded";
  created: string;
  updated: string;
  links: NodeLink[];
  content: string;
}

export interface TaskResidue {
  nodes: Array<{
    id?: string;
    title: string;
    type: string;
    content: string;
    links?: NodeLink[];
  }>;
  summary?: string;
}

export interface SnapshotRecord {
  session_id: string;
  reason: string;
  snapshot: string;
  timestamp: string;
}

// ── Multi-project types ──────────────────────────────────────

export interface ProjectConfig {
  mode: "isolated" | "shared";
  linkedTo: string[];
  created: string;
}

export interface DramConfig {
  version: number;
  projects: Record<string, ProjectConfig>;
}

export interface ProjectInfo {
  id: string;
  mode: "isolated" | "shared";
  linkedTo: string[];
  created: string;
  nodeCount: number;
}
