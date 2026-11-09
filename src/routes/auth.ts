import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  authResponseSchema,
  effectivePermissions,
  loginSchema,
  registerSchema,
  sessionUserSchema,
  type Role,
} from "../core";
import { prisma } from "../db";
import { signAccessToken } from "../lib/jwt";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../lib/password";
import { conflict, HttpError, unauthorized } from "../lib/errors";
import { requireAuth } from "../plugins/auth";

export const userSelect = { id: true, email: true, name: true, image: true, role: true, permissions: true } as const;

type DbUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: Role;
  permissions: string[];
};

function toSessionUser(u: DbUser) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    image: u.image,
    role: u.role,
    permissions: [...effectivePermissions(u.role, u.permissions)],
  };
}

export async function issue(u: DbUser) {
  const user = toSessionUser(u);
  const { token, expiresAt } = await signAccessToken({ sub: u.id, role: u.role, perms: user.permissions });
  return { user, accessToken: token, expiresAt };
}

/** Per-IP limit on credential endpoints (DESIGN/security: rate limiting on auth). */
const authRateLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/auth/register",
    {
      config: authRateLimit,
      schema: { tags: ["auth"], body: registerSchema, response: { 201: authResponseSchema } },
    },
    async (req, reply) => {
      const { name, email, password } = req.body;
      const exists = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (exists) {
        throw conflict("An account with this email already exists. Sign in instead.", {
          email: ["Already registered"],
        });
      }
      const user = await prisma.user.create({
        data: { name, email, passwordHash: await hashPassword(password), lastLoginAt: new Date() },
        select: userSelect,
      });
      return reply.code(201).send(await issue(user));
    },
  );

  app.post(
    "/auth/login",
    {
      config: authRateLimit,
      schema: { tags: ["auth"], body: loginSchema, response: { 200: authResponseSchema } },
    },
    async (req) => {
      const { email, password } = req.body;
      const user = await prisma.user.findUnique({
        where: { email },
        select: { ...userSelect, passwordHash: true, isActive: true },
      });
      const ok = user?.passwordHash
        ? await verifyPassword(password, user.passwordHash)
        : await burnPasswordCheck(password);
      if (!user || !ok) throw unauthorized("That email and password don't match. Try again.");
      if (!user.isActive) {
        throw new HttpError(403, "account_disabled", "This account is disabled. Contact support.");
      }
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      return issue(user);
    },
  );

  app.get(
    "/auth/me",
    {
      preHandler: requireAuth,
      schema: { tags: ["auth"], response: { 200: z.object({ user: sessionUserSchema }) } },
    },
    async (req) => {
      const user = await prisma.user.findUnique({
        where: { id: req.auth!.userId },
        select: { ...userSelect, isActive: true },
      });
      if (!user || !user.isActive) throw unauthorized("Your session has ended. Sign in again.");
      return { user: toSessionUser(user) };
    },
  );
};
