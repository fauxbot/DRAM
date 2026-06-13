import http from "http";
import type { Store } from "./store.js";

export function createHttpServer(store: Store, port: number): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    if (req.method === "POST" && req.url === "/checkpoint") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const { session_id, reason, snapshot } = JSON.parse(body);
          if (!session_id) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "session_id required" }));
            return;
          }
          store.recordSnapshot({
            session_id,
            reason: reason || "hook",
            snapshot: snapshot || "",
            timestamp: new Date().toISOString(),
          });
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid JSON body" }));
        }
      });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/scratchpad")) {
      const url = new URL(req.url, `http://localhost:${port}`);
      const sessionId = url.searchParams.get("session_id");
      if (!sessionId) {
        res.writeHead(400);
        res.end(
          JSON.stringify({ error: "session_id query parameter required" })
        );
        return;
      }
      const content = store.getScratchpad(sessionId);
      res.writeHead(200);
      res.end(JSON.stringify({ session_id: sessionId, scratchpad: content || "" }));
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  return server;
}
