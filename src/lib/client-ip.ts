import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

function header(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** True when the request carries the frontend's INTERNAL_API_SECRET. */
export function isInternalRequest(req: FastifyRequest, secret: string): boolean {
  const given = header(req, "x-diau-internal");
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Rate-limit identity. Calls from the Next.js server forward the shopper's IP
 * (trusted only with the internal secret); everything else uses the socket IP.
 */
export function rateLimitKey(req: FastifyRequest, secret: string): string {
  const forwarded = header(req, "x-diau-client-ip");
  return forwarded && isInternalRequest(req, secret) ? `client:${forwarded.slice(0, 64)}` : `ip:${req.ip}`;
}

/** Cached storefront reads from the Next.js server (no shopper IP) skip rate limiting. */
export function isInternalSharedRead(req: FastifyRequest, secret: string): boolean {
  return !header(req, "x-diau-client-ip") && isInternalRequest(req, secret);
}
