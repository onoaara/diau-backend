import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  authResponseSchema,
  effectivePermissions,
  loginSchema,
  oauthSignInSchema,
  registerSchema,
  sessionUserSchema,
  type Role,
} from "../core";
import { prisma } from "../db";
import { env } from "../env";
import { isInternalRequest } from "../lib/client-ip";
import { signAccessToken } from "../lib/jwt";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../lib/password";
import { conflict, forbidden, HttpError, unauthorized } from "../lib/errors";
import { requireAuth } from "../plugins/auth";
import { onCustomerRegistered } from "../realtime/events";

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
      const { firstName, lastName, email, phone, password, newsletter } = req.body;
      const exists = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (exists) {
        throw conflict("An account with this email already exists. Sign in instead.", {
          email: ["An account with this email already exists. Sign in instead."],
        });
      }
      const now = new Date();
      const user = await prisma.user.create({
        data: {
          name: `${firstName} ${lastName}`,
          email,
          phone: phone || null,
          termsAcceptedAt: now,
          passwordHash: await hashPassword(password),
          lastLoginAt: now,
        },
        select: userSelect,
      });
      // "Send me deals by email": join the newsletter list (already on it is fine).
      if (newsletter) {
        await prisma.newsletterSubscriber.upsert({ where: { email }, create: { email, source: "signup" }, update: {} }).catch(() => undefined);
      }
      void onCustomerRegistered(user.id);
      return reply.code(201).send(await issue(user));
    },
  );

  /**
   * Google / Apple sign-in. Only the web server may call this (internal secret):
   * Auth.js has already checked the provider's answer. Signs in the linked account;
   * otherwise links an existing account with the same email (only when the provider
   * verified that email), or creates a new account (no password) for them.
   */
  app.post(
    "/auth/oauth",
    {
      config: authRateLimit,
      schema: { tags: ["auth"], hide: true, body: oauthSignInSchema, response: { 200: authResponseSchema } },
    },
    async (req) => {
      if (!isInternalRequest(req, env.INTERNAL_API_SECRET)) throw forbidden();
      const { provider, providerAccountId, email, emailVerified, name, image } = req.body;
      const now = new Date();

      const linked = await prisma.account.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId } },
        select: { user: { select: { ...userSelect, isActive: true } } },
      });
      let user = linked?.user ?? null;
      let created = false;

      if (!user) {
        const existing = await prisma.user.findUnique({ where: { email }, select: { ...userSelect, isActive: true } });
        if (existing && !emailVerified) {
          throw conflict("An account with this email already exists. Sign in with your password instead.");
        }
        if (existing) {
          user = existing;
        } else {
          user = await prisma.user.create({
            data: { email, name: name || null, image: image || null, emailVerified: emailVerified ? now : null, termsAcceptedAt: now },
            select: { ...userSelect, isActive: true },
          });
          created = true;
        }
        await prisma.account.create({ data: { userId: user.id, type: "oidc", provider, providerAccountId } });
      }

      if (!user.isActive) throw new HttpError(403, "account_disabled", "This account is disabled. Contact support.");
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now, ...(user.image || !image ? {} : { image }) } });
      if (created) void onCustomerRegistered(user.id);
      return issue(user);
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
      // Says which field is wrong (the store owner asked for it). The password check still
      // runs for unknown emails, so both answers take the same time; the 10-a-minute
      // rate limit above keeps anyone from testing lots of emails.
      if (!user?.passwordHash) {
        throw new HttpError(401, "unknown_email", "There's no account with this email.", { email: ["There's no account with this email."] });
      }
      if (!ok) throw new HttpError(401, "wrong_password", "That password isn't right.", { password: ["That password isn't right. Try again."] });
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
