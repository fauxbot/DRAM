#!/usr/bin/env node

import path from "path";
import os from "os";
import fs from "fs";
import { Store } from "./store.js";
import { detectProvider } from "./embeddings.js";

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const rootDir = getFlag("data-dir") || process.env.DRAM_DATA_DIR || path.join(os.homedir(), ".dram");
const targetProject = getFlag("project");

const embedder = await detectProvider();

async function rebuildProject(dataDir: string, label: string): Promise<void> {
  if (!fs.existsSync(path.join(dataDir, "nodes"))) {
    console.log(`[${label}] No nodes directory found, skipping.`);
    return;
  }

  const store = new Store(dataDir);
  store.setEmbeddingProvider(embedder);

  const count = store.rebuildIndex();
  console.log(`[${label}] Rebuilt index: ${count} node(s) re-indexed.`);

  const enriched = await store.rebuildEnrichments();
  console.log(`[${label}] Enriched: ${enriched} node(s) with entities, claims, and embeddings.`);

  store.close();
}

if (targetProject) {
  const projectDir = path.join(rootDir, "projects", targetProject);
  if (!fs.existsSync(projectDir)) {
    console.error(`Project "${targetProject}" not found at ${projectDir}`);
    process.exit(1);
  }
  await rebuildProject(projectDir, targetProject);
} else {
  const projectsDir = path.join(rootDir, "projects");
  if (fs.existsSync(projectsDir)) {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await rebuildProject(path.join(projectsDir, entry.name), entry.name);
      }
    }
  }

  const legacyNodes = path.join(rootDir, "nodes");
  if (fs.existsSync(legacyNodes) && fs.readdirSync(legacyNodes).length > 0) {
    await rebuildProject(rootDir, "_legacy_root");
  }

  if (!fs.existsSync(projectsDir) || fs.readdirSync(projectsDir).length === 0) {
    const store = new Store(process.env.DRAM_DATA_DIR || undefined);
    store.setEmbeddingProvider(embedder);
    const count = store.rebuildIndex();
    console.log(`Rebuilt index: ${count} node(s) re-indexed.`);
    const enriched = await store.rebuildEnrichments();
    console.log(`Enriched: ${enriched} node(s) with entities, claims, and embeddings.`);
    store.close();
  }
}
