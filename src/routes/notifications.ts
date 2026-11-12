import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { NOTIFICATION_TYPES, notificationDto, notificationPrefsSchema, pushSubscriptionInput, readPrefs } from "../core";
import { prisma } from "../db";
import { env } from "../env";
import { loadAuthUser, requireAuth } from "../plugins/auth";
import { pushEnabled } from "../realtime/push";
import { announceVersion, signSocketTicket } from "../realtime/socket";
import { isInternalRequest } from "../lib/client-ip";
import { forbidden } from "../lib/errors";

/** Notifications, settings, push devices and the socket ticket (DESIGN.md §5.22). Signed-in only. */
export const notificationRoutes: FastifyPluginAsyncZod = async (app) => {
  const toDto = (n: { id: string; type: string; title: string; body: string; link: string | null; imageUrl: string | null; readAt: Date | null; createdAt: Date }) => ({
    ...n,
    type: n.type as (typeof NOTIFICATION_TYPES)[number],
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  });

  // The web server reports its build (internal secret only), for the "new version" prompt.
  app.post(
    "/realtime/version",
    { schema: { tags: ["realtime"], hide: true, body: z.object({ version: z.string().min(3).max(120) }), response: { 204: z.null() } } },
    async (req, reply) => {
      if (!isInternalRequest(req, env.INTERNAL_API_SECRET)) throw forbidden();
      announceVersion(req.body.version);
      return reply.code(204).send(null);
    },
  );

  app.post("/realtime/ticket", { preHandler: requireAuth, schema: { tags: ["realtime"], response: { 200: z.object({ ticket: z.string() }) } } }, async (req) => {
    const user = await loadAuthUser(req);
    return { ticket: await signSocketTicket(user.id, user.role) };
  });

  app.get(
    "/notifications",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["notifications"],
        querystring: z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(50).default(20), unread: z.enum(["1"]).optional() }),
        response: { 200: z.object({ items: z.array(notificationDto), unread: z.number().int(), hasMore: z.boolean() }) },
      },
    },
    async (req) => {
      const userId = req.auth!.userId;
      const { before, limit, unread } = req.query;
      const [rows, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where: { userId, ...(before ? { createdAt: { lt: new Date(before) } } : {}), ...(unread ? { readAt: null } : {}) },
          orderBy: { createdAt: "desc" },
          take: limit + 1,
        }),
        prisma.notification.count({ where: { userId, readAt: null } }),
      ]);
      return { items: rows.slice(0, limit).map(toDto), unread: unreadCount, hasMore: rows.length > limit };
    },
  );

  app.get("/notifications/unread-count", { preHandler: requireAuth, schema: { tags: ["notifications"], response: { 200: z.object({ unread: z.number().int() }) } } }, async (req) => ({
    unread: await prisma.notification.count({ where: { userId: req.auth!.userId, readAt: null } }),
  }));

  app.post(
    "/notifications/read",
    { preHandler: requireAuth, schema: { tags: ["notifications"], body: z.object({ ids: z.array(z.string().max(40)).max(100).optional() }), response: { 200: z.object({ unread: z.number().int() }) } } },
    async (req) => {
      const userId = req.auth!.userId;
      await prisma.notification.updateMany({ where: { userId, readAt: null, ...(req.body.ids ? { id: { in: req.body.ids } } : {}) }, data: { readAt: new Date() } });
      return { unread: await prisma.notification.count({ where: { userId, readAt: null } }) };
    },
  );

  const prefsResponse = z.object({ prefs: notificationPrefsSchema, push: z.object({ enabled: z.boolean(), publicKey: z.string() }) });

  app.get("/notifications/settings", { preHandler: requireAuth, schema: { tags: ["notifications"], response: { 200: prefsResponse } } }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { notificationPrefs: true } });
    return { prefs: readPrefs(user?.notificationPrefs), push: { enabled: pushEnabled, publicKey: env.VAPID_PUBLIC_KEY } };
  });

  app.put("/notifications/settings", { preHandler: requireAuth, schema: { tags: ["notifications"], body: notificationPrefsSchema, response: { 200: prefsResponse } } }, async (req) => {
    const prefs = notificationPrefsSchema.parse(req.body);
    await prisma.user.update({ where: { id: req.auth!.userId }, data: { notificationPrefs: prefs } });
    return { prefs, push: { enabled: pushEnabled, publicKey: env.VAPID_PUBLIC_KEY } };
  });

  app.post(
    "/push/subscriptions",
    { preHandler: requireAuth, schema: { tags: ["notifications"], body: pushSubscriptionInput, response: { 204: z.null() } } },
    async (req, reply) => {
      const { endpoint, keys } = req.body;
      const userAgent = String(req.headers["user-agent"] ?? "").slice(0, 300) || null;
      // One row per device; a device that changes hands moves to the new account.
      await prisma.pushSubscription.upsert({
        where: { endpoint },
        create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, userId: req.auth!.userId, userAgent },
        update: { p256dh: keys.p256dh, auth: keys.auth, userId: req.auth!.userId, userAgent },
      });
      return reply.code(204).send(null);
    },
  );

  app.delete(
    "/push/subscriptions",
    { preHandler: requireAuth, schema: { tags: ["notifications"], body: z.object({ endpoint: z.url().max(2000) }), response: { 204: z.null() } } },
    async (req, reply) => {
      await prisma.pushSubscription.deleteMany({ where: { endpoint: req.body.endpoint, userId: req.auth!.userId } });
      return reply.code(204).send(null);
    },
  );
};
