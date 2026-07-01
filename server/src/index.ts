#!/usr/bin/env node

import path from "path";
import os from "os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProjectManager } from "./project-manager.js";
import { createHttpServer, closeAllTransports } from "./http.js";
import { detectProvider } from "./embeddings.js";
import { createMcpServer, getTransportMode } from "./transport.js";
import { isAuthEnabled } from "./auth.js";

function parseArgs(): { dataDir?: string; rootDir: string } {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf("--data-dir");
  const raw = flagIdx !== -1 ? args[flagIdx + 1] : process.env.DRAM_DATA_DIR;

  const home = os.homedir();
  const defaultRoot = path.join(home, ".dram");

  if (!raw) {
    return { rootDir: defaultRoot };
  }

  let resolved = raw;
  if (resolved.startsWith("~")) {
    resolved = path.join(home, resolved.slice(1));
  }

  return { dataDir: resolved, rootDir: defaultRoot };
}

const { dataDir, rootDir } = parseArgs();
const HTTP_PORT = parseInt(process.env.DRAM_HTTP_PORT || "3577", 10);
const HTTP_HOST = process.env.DRAM_HTTP_HOST || "127.0.0.1";
const mode = getTransportMode();

const pm = new ProjectManager(rootDir, dataDir);

const embedder = await detectProvider();
pm.setEmbeddingProvider(embedder);

process.stderr.write(
  `dram: root=${rootDir}, transport=${mode}, auth=${isAuthEnabled() ? "enabled" : "disabled"}\n`
);

const projects = pm.listProjects();
if (projects.length > 0) {
  process.stderr.write(
    `dram: ${projects.length} project(s): ${projects.map((p) => `${p.id}(${p.nodeCount})`).join(", ")}\n`
  );
}

let httpServer: ReturnType<typeof createHttpServer> | null = null;

if (mode === "http" || mode === "both") {
  const enableMcp = true;
  httpServer = createHttpServer(pm, HTTP_PORT, { enableMcp });
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
  const mcpServer = createMcpServer(pm);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  process.stderr.write("dram: MCP server running on stdio\n");
}

function shutdown() {
  closeAllTransports().finally(() => {
    pm.close();
    if (httpServer) httpServer.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
