#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./store.js";
import { registerTools } from "./tools.js";
import { createHttpServer } from "./http.js";
import { detectProvider } from "./embeddings.js";

const DATA_DIR = process.env.DRAM_DATA_DIR || undefined;
const HTTP_PORT = parseInt(process.env.DRAM_HTTP_PORT || "3577", 10);

const store = new Store(DATA_DIR);

// Detect and configure embedding provider before starting MCP
const embedder = await detectProvider();
store.setEmbeddingProvider(embedder);

const mcpServer = new McpServer({
  name: "dram",
  version: "0.2.0",
});

registerTools(mcpServer, store);

const httpServer = createHttpServer(store, HTTP_PORT);
httpServer.listen(HTTP_PORT, () => {
  process.stderr.write(`dram HTTP server listening on port ${HTTP_PORT}\n`);
});

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
process.stderr.write("dram MCP server running on stdio\n");

function shutdown() {
  store.close();
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
