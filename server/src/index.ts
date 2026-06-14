#!/usr/bin/env node

import path from "path";
import os from "os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./store.js";
import { createHttpServer, closeAllTransports } from "./http.js";
import { detectProvider } from "./embeddings.js";
import { createMcpServer, getTransportMode } from "./transport.js";
import { isAuthEnabled } from "./auth.js";

function parseDataDir(): string | undefined {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf("--data-dir");
  const raw = flagIdx !== -1 ? args[flagIdx + 1] : process.env.DRAM_DATA_DIR;
  if (!raw) return undefined;
  if (raw.startsWith("~")) {
    return path.join(os.homedir(), raw.slice(1));
  }
  return raw;
}

const DATA_DIR = parseDataDir();
const HTTP_PORT = parseInt(process.env.DRAM_HTTP_PORT || "3577", 10);
const HTTP_HOST = process.env.DRAM_HTTP_HOST || "127.0.0.1";
const mode = getTransportMode();

const store = new Store(DATA_DIR);

const embedder = await detectProvider();
store.setEmbeddingProvider(embedder);

process.stderr.write(
  `dram: data=${store.getDataDir()}, transport=${mode}, auth=${isAuthEnabled() ? "enabled" : "disabled"}\n`
);

let httpServer: ReturnType<typeof createHttpServer> | null = null;

if (mode === "http" || mode === "both") {
  const enableMcp = true;
  httpServer = createHttpServer(store, HTTP_PORT, { enableMcp });
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
    process.stderr.write(
      `dram: listening on ${HTTP_HOST}:${HTTP_PORT} (MCP + HTTP API)\n`
    );
  });
}

if (mode === "stdio" || mode === "both") {
  const mcpServer = createMcpServer(store);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  process.stderr.write("dram: MCP server running on stdio\n");
}

function shutdown() {
  closeAllTransports().finally(() => {
    store.close();
    if (httpServer) httpServer.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
