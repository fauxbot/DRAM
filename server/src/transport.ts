import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectManager } from "./project-manager.js";
import { registerTools } from "./tools.js";

export type TransportMode = "stdio" | "http" | "both";

export function getTransportMode(): TransportMode {
  const mode = (process.env.DRAM_TRANSPORT || "stdio").toLowerCase();
  if (mode === "stdio" || mode === "http" || mode === "both") return mode;
  return "stdio";
}

export function createMcpServer(pm: ProjectManager): McpServer {
  const server = new McpServer({
    name: "dram",
    version: "0.5.0",
  });
  registerTools(server, pm);
  return server;
}
