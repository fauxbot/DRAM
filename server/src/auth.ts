import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const AUTH_TOKEN = process.env.DRAM_AUTH_TOKEN || "";

export function isAuthEnabled(): boolean {
  return AUTH_TOKEN.length > 0;
}

export function validateBearerToken(req: IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  const header = req.headers.authorization;
  if (!header) return false;
  const [scheme, token] = header.split(" ", 2);
  if (scheme !== "Bearer" || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(AUTH_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
