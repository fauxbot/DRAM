#!/usr/bin/env node

import path from "node:path";
import os from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProjectManager } from "./project-manager.js";
import { createHttpServer, closeAllTransports } from "./http.js";
import { detectProvider } from "./embeddings.js";
import { createMcpServer, getTransportMode } from "./transport.js";
import { isAuthEnabled } from "./auth.js";
import { loadTlsOptions, getTlsMode } from "./tls.js";

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

function parseProjectAllowlist(): string[] | null {
  const raw = process.env.DRAM_PROJECTS_ALLOW;
  if (!raw) return null;
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

const { dataDir, rootDir } = parseArgs();
const HTTP_PORT = parseInt(process.env.DRAM_HTTP_PORT || "3577", 10);
const HTTP_HOST = process.env.DRAM_HTTP_HOST || "127.0.0.1";
const mode = getTransportMode();
const tlsMode = getTlsMode();

const pm = new ProjectManager(rootDir, dataDir);

const allowlist = parseProjectAllowlist();
if (allowlist) {
  pm.setProjectAllowlist(allowlist);
}

const embedder = await detectProvider();
pm.setEmbeddingProvider(embedder);

const isRemote = HTTP_HOST === "0.0.0.0" || HTTP_HOST === "::";

process.stderr.write(
  `dram: root=${rootDir}, transport=${mode}, tls=${tlsMode}, auth=${isAuthEnabled() ? "enabled" : "disabled"}\n`
);

if (allowlist) {
  process.stderr.write(
    `dram: project allowlist: ${allowlist.join(", ")}\n`
  );
}

const projects = pm.listProjects();
if (projects.length > 0) {
  process.stderr.write(
    `dram: ${projects.length} project(s): ${projects.map((p) => `${p.id}(${p.nodeCount})`).join(", ")}\n`
  );
}

if (isRemote && !isAuthEnabled() && (mode === "http" || mode === "both")) {
  process.stderr.write(
    "dram: WARNING — binding to all interfaces without auth. Set DRAM_AUTH_TOKEN for production use.\n"
  );
}

if (isRemote && tlsMode === "off" && (mode === "http" || mode === "both")) {
  process.stderr.write(
    "dram: WARNING — remote binding without TLS. Set DRAM_TLS=auto or use a reverse proxy.\n"
  );
}

let httpServer: ReturnType<typeof createHttpServer> | null = null;

if (mode === "http" || mode === "both") {
  const tlsOptions = await loadTlsOptions(rootDir);
  const enableMcp = true;
  httpServer = createHttpServer(pm, HTTP_PORT, { enableMcp, tlsOptions });
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `dram: port ${HTTP_PORT} in use, HTTP API disabled\n`
      );
    } else {
      process.stderr.write(`dram: HTTP server error: ${err.message}\n`);
    }
  });
  const proto = tlsOptions ? "https" : "http";
  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    process.stderr.write(
      `dram: listening on ${proto}://${HTTP_HOST}:${HTTP_PORT} (MCP + HTTP API)\n`
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
