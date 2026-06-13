#!/usr/bin/env node

import { Store } from "./store.js";
import { detectProvider } from "./embeddings.js";

const store = new Store(process.env.DRAM_DATA_DIR || undefined);

const embedder = await detectProvider();
store.setEmbeddingProvider(embedder);

const count = store.rebuildIndex();
console.log(`Rebuilt index: ${count} node(s) re-indexed.`);

const enriched = await store.rebuildEnrichments();
console.log(`Enriched: ${enriched} node(s) with entities, claims, and embeddings.`);

store.close();
