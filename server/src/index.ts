#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./store.js";
import { createHttpServer, closeAllTransports } from "./http.js";
import { detectProvider } from "./embeddings.js";
import { createMcpServer, getTransportMode } from "./transport.js";
import { isAuthEnabled } from "./auth.js";

const DATA_DIR = process.env.DRAM_DATA_DIR || undefined;
const HTTP_PORT = parseInt(process.env.DRAM_HTTP_PORT || "3577", 10);
const HTTP_HOST = process.env.DRAM_HTTP_HOST || "127.0.0.1";
const mode = getTransportMode();

const store = new Store(DATA_DIR);

const embedder = await detectProvider();
store.setEmbeddingProvider(embedder);

process.stderr.write(
  `dram: transport=${mode}, auth=${isAuthEnabled() ? "enabled" : "disabled"}\n`
);

const enableMcp = mode === "http" || mode === "both";
const httpServer = createHttpServer(store, HTTP_PORT, { enableMcp });
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `dram: port ${HTTP_PORT} in use, HTTP API disabled\n`
    );
  } else {
    process.stderr.write(`dram: HTTP server error: ${err.message}\n`);
  }
});
httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  const features = enableMcp ? "MCP + HTTP API" : "HTTP API only";
  process.stderr.write(
    `dram: listening on ${HTTP_HOST}:${HTTP_PORT} (${features})\n`
  );
});

if (mode === "stdio" || mode === "both") {
  const mcpServer = createMcpServer(store);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  process.stderr.write("dram: MCP server running on stdio\n");
}

function shutdown() {
  closeAllTransports().finally(() => {
    store.close();
    httpServer.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
