import type { IncomingMessage } from "http";

const AUTH_TOKEN = process.env.DRAM_AUTH_TOKEN || "";

export function isAuthEnabled(): boolean {
  return AUTH_TOKEN.length > 0;
}

export function validateBearerToken(req: IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  const header = req.headers.authorization;
  if (!header) return false;
  const [scheme, token] = header.split(" ", 2);
  return scheme === "Bearer" && token === AUTH_TOKEN;
}
