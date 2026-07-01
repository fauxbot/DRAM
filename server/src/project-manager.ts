import fs from "fs";
import path from "path";
import { Store } from "./store.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { DramConfig, ProjectConfig, ProjectInfo } from "./types.js";

const CONFIG_VERSION = 1;
const DEFAULT_PROJECT = "_default";

export class ProjectManager {
  private rootDir: string;
  private projectsDir: string;
  private configPath: string;
  private config: DramConfig;
  private stores: Map<string, Store> = new Map();
  private embedder: EmbeddingProvider | null = null;
  private legacyDataDir: string | undefined;

  constructor(rootDir: string, legacyDataDir?: string) {
    this.rootDir = rootDir;
    this.projectsDir = path.join(rootDir, "projects");
    this.configPath = path.join(rootDir, "config.json");
    this.legacyDataDir = legacyDataDir;

    fs.mkdirSync(this.projectsDir, { recursive: true });

    this.config = this.loadConfig();
    this.autoMigrateLegacyData();
  }

  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embedder = provider;
    for (const store of this.stores.values()) {
      store.setEmbeddingProvider(provider);
    }
  }

  resolveStore(project?: string): { store: Store; isNew: boolean; projectId: string } {
    const projectId = this.sanitizeProjectId(project || DEFAULT_PROJECT);
    return this.getOrCreateProject(projectId);
  }

  getOrCreateProject(projectId: string): { store: Store; isNew: boolean } & { projectId: string } {
    const existing = this.stores.get(projectId);
    if (existing) {
      return { store: existing, isNew: false, projectId };
    }

    const isNew = !this.config.projects[projectId];

    if (isNew) {
      this.config.projects[projectId] = {
        mode: "isolated",
        linkedTo: [],
        created: new Date().toISOString(),
      };
      this.saveConfig();
    }

    const dataDir = this.projectDataDir(projectId);
    const store = new Store(dataDir);
    if (this.embedder) {
      store.setEmbeddingProvider(this.embedder);
    }
    this.stores.set(projectId, store);

    return { store, isNew, projectId };
  }

  getLinkedStores(projectId: string): Array<{ store: Store; projectId: string }> {
    const projectConfig = this.config.projects[projectId];
    if (!projectConfig || projectConfig.mode !== "shared") return [];

    const linkedIds = this.resolveLinks(projectId);
    const results: Array<{ store: Store; projectId: string }> = [];

    for (const linkedId of linkedIds) {
      const { store } = this.getOrCreateProject(linkedId);
      results.push({ store, projectId: linkedId });
    }

    return results;
  }

  configureProject(
    projectId: string,
    updates: { mode?: "isolated" | "shared"; link?: string[]; unlink?: string[] }
  ): ProjectConfig {
    const id = this.sanitizeProjectId(projectId);
    if (!this.config.projects[id]) {
      this.getOrCreateProject(id);
    }

    const config = this.config.projects[id];

    if (updates.mode !== undefined) {
      config.mode = updates.mode;
    }

    if (updates.link) {
      for (const target of updates.link) {
        const targetId = this.sanitizeProjectId(target);
        if (targetId === id) continue;
        if (!this.config.projects[targetId]) {
          this.getOrCreateProject(targetId);
        }
        if (!config.linkedTo.includes(targetId)) {
          config.linkedTo.push(targetId);
        }
        const targetConfig = this.config.projects[targetId];
        if (!targetConfig.linkedTo.includes(id)) {
          targetConfig.linkedTo.push(id);
        }
      }
    }

    if (updates.unlink) {
      for (const target of updates.unlink) {
        const targetId = this.sanitizeProjectId(target);
        config.linkedTo = config.linkedTo.filter((l) => l !== targetId);
        const targetConfig = this.config.projects[targetId];
        if (targetConfig) {
          targetConfig.linkedTo = targetConfig.linkedTo.filter((l) => l !== id);
        }
      }
    }

    this.saveConfig();
    return config;
  }

  listProjects(): ProjectInfo[] {
    const results: ProjectInfo[] = [];

    for (const [id, config] of Object.entries(this.config.projects)) {
      let nodeCount = 0;
      try {
        const nodesDir = path.join(this.projectDataDir(id), "nodes");
        if (fs.existsSync(nodesDir)) {
          nodeCount = fs.readdirSync(nodesDir).filter((f) => f.endsWith(".md")).length;
        }
      } catch {
        // directory may not exist yet
      }

      results.push({
        id,
        mode: config.mode,
        linkedTo: config.linkedTo,
        created: config.created,
        nodeCount,
      });
    }

    return results;
  }

  getProjectConfig(projectId: string): ProjectConfig | undefined {
    return this.config.projects[this.sanitizeProjectId(projectId)];
  }

  getRootDir(): string {
    return this.rootDir;
  }

  close(): void {
    for (const store of this.stores.values()) {
      store.close();
    }
    this.stores.clear();
  }

  private resolveLinks(projectId: string): string[] {
    const visited = new Set<string>();
    const directLinks = new Set<string>();

    const config = this.config.projects[projectId];
    if (!config) return [];

    for (const linkedId of config.linkedTo) {
      if (linkedId !== projectId && !visited.has(linkedId)) {
        directLinks.add(linkedId);
      }
    }

    for (const [otherId, otherConfig] of Object.entries(this.config.projects)) {
      if (otherId !== projectId && otherConfig.linkedTo.includes(projectId)) {
        directLinks.add(otherId);
      }
    }

    return [...directLinks];
  }

  private projectDataDir(projectId: string): string {
    if (projectId === DEFAULT_PROJECT && this.legacyDataDir) {
      return this.legacyDataDir;
    }
    return path.join(this.projectsDir, projectId);
  }

  private sanitizeProjectId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  }

  private loadConfig(): DramConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        const parsed = JSON.parse(raw) as DramConfig;
        if (parsed.version === CONFIG_VERSION) {
          return parsed;
        }
      }
    } catch {
      // corrupt or missing — start fresh
    }
    return { version: CONFIG_VERSION, projects: {} };
  }

  private saveConfig(): void {
    fs.writeFileSync(
      this.configPath,
      JSON.stringify(this.config, null, 2),
      "utf-8"
    );
  }

  private autoMigrateLegacyData(): void {
    if (this.legacyDataDir) return;

    const legacyIndex = path.join(this.rootDir, "index.db");
    const legacyNodes = path.join(this.rootDir, "nodes");
    const legacyScratchpads = path.join(this.rootDir, "scratchpads");

    const hasLegacyData =
      fs.existsSync(legacyIndex) ||
      (fs.existsSync(legacyNodes) && fs.readdirSync(legacyNodes).length > 0) ||
      (fs.existsSync(legacyScratchpads) && fs.readdirSync(legacyScratchpads).length > 0);

    if (!hasLegacyData) return;

    const defaultDir = path.join(this.projectsDir, DEFAULT_PROJECT);
    if (fs.existsSync(defaultDir)) return;

    fs.mkdirSync(defaultDir, { recursive: true });

    const toMove = ["index.db", "index.db-shm", "index.db-wal", "nodes", "scratchpads", "archive"];
    for (const item of toMove) {
      const src = path.join(this.rootDir, item);
      const dest = path.join(defaultDir, item);
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
      }
    }

    if (!this.config.projects[DEFAULT_PROJECT]) {
      this.config.projects[DEFAULT_PROJECT] = {
        mode: "isolated",
        linkedTo: [],
        created: new Date().toISOString(),
      };
      this.saveConfig();
    }

    process.stderr.write(
      `dram: migrated legacy data to projects/${DEFAULT_PROJECT}/\n`
    );
  }
}
