#!/usr/bin/env node

import { Store } from "./store.js";

const store = new Store(process.env.DRAM_DATA_DIR || undefined);
const count = store.rebuildIndex();
console.log(`Rebuilt index: ${count} node(s) re-indexed.`);
store.close();
