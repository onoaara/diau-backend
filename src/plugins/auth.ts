import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { effectivePermissions, type Permission, type Role } from "../core";
import { prisma } from "../db";
import { verifyAccessToken } from "../lib/jwt";
import { forbidden, unauthorized } from "../lib/errors";

export type AuthUser = { id: string; role: Role; permissions: readonly Permission[] };

declare module "fastify" {
  interface FastifyRequest {
    /** Identity from a valid bearer token (not re-checked against the DB). */
    auth: { userId: string; role: Role } | null;
  }
}

export default fp(async (app) => {
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;
    const claims = await verifyAccessToken(header.slice(7));
    if (claims) req.auth = { userId: claims.sub, role: claims.role };
  });
}, { name: "auth" });

/** Requires any signed-in, active user. */
export const requireAuth: preHandlerAsyncHookHandler = async (req: FastifyRequest, _reply: FastifyReply) => {
  if (!req.auth) throw unauthorized();
  // Blocking an account (Admin → Customers) takes effect on the next request, not at token expiry.
  const user = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { isActive: true } });
  if (!user?.isActive) throw unauthorized("Your session has ended. Sign in again.");
};

/**
 * Loads the user's *current* role and permissions from the DB (so demotions and
 * deactivations apply immediately) and enforces `permission`.
 */
export async function loadAuthUser(req: FastifyRequest): Promise<AuthUser> {
  if (!req.auth) throw unauthorized();
  const user = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { id: true, role: true, permissions: true, isActive: true },
  });
  if (!user || !user.isActive) throw unauthorized("Your session has ended. Sign in again.");
  return { id: user.id, role: user.role, permissions: effectivePermissions(user.role, user.permissions) };
}

export function requirePermission(permission: Permission): preHandlerAsyncHookHandler {
  return async (req) => {
    const user = await loadAuthUser(req);
    if (!user.permissions.includes(permission)) throw forbidden();
    req.authUser = user;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requirePermission(): DB-verified admin user. */
    authUser?: AuthUser;
  }
}
