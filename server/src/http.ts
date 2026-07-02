import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { ServerOptions } from "node:https";
import type { ProjectManager } from "./project-manager.js";
import { ProjectNotAllowedError } from "./project-manager.js";
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

// --- CORS ---

function parseCorsOrigins(): string[] | "*" | null {
  const raw = process.env.DRAM_CORS_ORIGINS;
  if (!raw) return null;
  if (raw.trim() === "*") return "*";
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

const corsOrigins = parseCorsOrigins();

function handleCors(
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  if (!corsOrigins) return false;

  const origin = req.headers.origin;
  if (!origin) return false;

  const allowed =
    corsOrigins === "*" ||
    corsOrigins.includes(origin);

  if (allowed) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      corsOrigins === "*" ? "*" : origin
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, DELETE, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id"
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(allowed ? 204 : 403);
    res.end();
    return true;
  }

  return false;
}

// --- MCP transport ---

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

// --- Server factory ---

export interface HttpServerOptions {
  enableMcp?: boolean;
  tlsOptions?: ServerOptions | null;
}

export function createHttpServer(
  pm: ProjectManager,
  port: number,
  options?: HttpServerOptions
): http.Server | https.Server {
  const enableMcp = options?.enableMcp ?? false;
  const tlsOptions = options?.tlsOptions ?? null;

  const handler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    if (handleCors(req, res)) return;

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
        } catch (err) {
          if (err instanceof ProjectNotAllowedError) {
            sendJson(res, 403, { error: err.message });
            return;
          }
          sendJson(res, 400, { error: "invalid JSON body" });
        }
      });
      return;
    }

    if (req.method === "GET" && url?.startsWith("/scratchpad")) {
      const proto = tlsOptions ? "https" : "http";
      const parsedUrl = new URL(url, `${proto}://localhost:${port}`);
      const sessionId = parsedUrl.searchParams.get("session_id");
      const project = parsedUrl.searchParams.get("project") || undefined;
      if (!sessionId) {
        sendJson(res, 400, { error: "session_id query parameter required" });
        return;
      }
      try {
        const { store } = pm.resolveStore(project);
        const content = store.getScratchpad(sessionId);
        sendJson(res, 200, {
          session_id: sessionId,
          scratchpad: content || "",
        });
      } catch (err) {
        if (err instanceof ProjectNotAllowedError) {
          sendJson(res, 403, { error: err.message });
          return;
        }
        throw err;
      }
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
      try {
        const { store } = pm.resolveStore(project);
        const handler = new MaintenanceHandler(store, store.getDb());
        handler
          .run()
          .then((result) => sendJson(res, 200, result))
          .catch((err) =>
            sendJson(res, 500, { error: (err as Error).message })
          );
      } catch (err) {
        if (err instanceof ProjectNotAllowedError) {
          sendJson(res, 403, { error: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    if (req.method === "GET" && url === "/health") {
      const projects = pm.listProjects();
      sendJson(res, 200, {
        status: "ok",
        version: "0.5.0",
        tls: !!tlsOptions,
        auth: isAuthEnabled(),
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
  };

  if (tlsOptions) {
    return https.createServer(tlsOptions, handler);
  }
  return http.createServer(handler);
}
