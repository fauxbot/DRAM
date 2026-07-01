import http from "http";
import { randomUUID } from "node:crypto";
import type { ProjectManager } from "./project-manager.js";
import { MaintenanceHandler } from "./maintenance.js";
import { validateBearerToken, isAuthEnabled } from "./auth.js";
import { createMcpServer } from "./transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const transports: Record<string, StreamableHTTPServerTransport> = {};

export async function closeAllTransports(): Promise<void> {
  for (const sessionId of Object.keys(transports)) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch {
      delete transports[sessionId];
    }
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pm: ProjectManager
): Promise<void> {
  const method = req.method;
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (method === "POST") {
    const rawBody = await readBody(req);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
      return;
    }

    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, parsedBody);
      return;
    }

    if (!sessionId && isInitializeRequest(parsedBody)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
        }
      };

      const server = createMcpServer(pm);
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid session" },
      id: null,
    });
    return;
  }

  if (method === "GET" || method === "DELETE") {
    if (!sessionId || !transports[sessionId]) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session ID" },
        id: null,
      });
      return;
    }
    await transports[sessionId].handleRequest(req, res);
    return;
  }

  res.writeHead(405);
  res.end();
}

export interface HttpServerOptions {
  enableMcp?: boolean;
}

export function createHttpServer(
  pm: ProjectManager,
  port: number,
  options?: HttpServerOptions
): http.Server {
  const enableMcp = options?.enableMcp ?? false;

  const server = http.createServer(async (req, res) => {
    if (!validateBearerToken(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const url = req.url || "";

    if (enableMcp && url.startsWith("/mcp")) {
      try {
        await handleMcpRequest(req, res, pm);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
      return;
    }

    res.setHeader("Content-Type", "application/json");

    if (req.method === "POST" && url === "/checkpoint") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const { session_id, reason, snapshot, project } = JSON.parse(body);
          if (!session_id) {
            sendJson(res, 400, { error: "session_id required" });
            return;
          }
          const { store } = pm.resolveStore(project);
          store.recordSnapshot({
            session_id,
            reason: reason || "hook",
            snapshot: snapshot || "",
            timestamp: new Date().toISOString(),
          });
          sendJson(res, 200, { ok: true });
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
        }
      });
      return;
    }

    if (req.method === "GET" && url?.startsWith("/scratchpad")) {
      const parsedUrl = new URL(url, `http://localhost:${port}`);
      const sessionId = parsedUrl.searchParams.get("session_id");
      const project = parsedUrl.searchParams.get("project") || undefined;
      if (!sessionId) {
        sendJson(res, 400, { error: "session_id query parameter required" });
        return;
      }
      const { store } = pm.resolveStore(project);
      const content = store.getScratchpad(sessionId);
      sendJson(res, 200, {
        session_id: sessionId,
        scratchpad: content || "",
      });
      return;
    }

    if (req.method === "POST" && url === "/maintain") {
      const rawBody = await readBody(req);
      let project: string | undefined;
      try {
        const parsed = JSON.parse(rawBody);
        project = parsed.project;
      } catch {
        // no body or invalid — use default project
      }
      const { store } = pm.resolveStore(project);
      const handler = new MaintenanceHandler(store, store.getDb());
      handler
        .run()
        .then((result) => sendJson(res, 200, result))
        .catch((err) =>
          sendJson(res, 500, { error: (err as Error).message })
        );
      return;
    }

    if (req.method === "GET" && url === "/health") {
      const projects = pm.listProjects();
      sendJson(res, 200, {
        status: "ok",
        version: "0.5.0",
        projects: projects.length,
        projectList: projects.map((p) => ({
          id: p.id,
          mode: p.mode,
          nodes: p.nodeCount,
        })),
      });
      return;
    }

    if (req.method === "GET" && url === "/projects") {
      sendJson(res, 200, { projects: pm.listProjects() });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  return server;
}
