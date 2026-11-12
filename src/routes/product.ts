import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { liveProductSlugs, productDetailDto, readProductDetail, reviewPage, reviewPageDto } from "../catalog/product-detail";
import { actorFrom, recordEvents, recordView } from "../analytics/events";
import { liveProductWhere } from "../catalog/product-feed";
import { createReview, reviewEligibility, reviewInputSchema } from "../catalog/reviews";
import { TAGS } from "../core";
import { prisma } from "../db";
import { notFound } from "../lib/errors";
import { revalidateFrontend } from "../lib/revalidate";
import { loadAuthUser, requireAuth } from "../plugins/auth";

const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,120}$/) });
const productIdParam = z.object({ productId: z.string().regex(/^[a-z0-9]{10,40}$/i) });

async function liveProductIdBySlug(slug: string): Promise<string> {
  const p = await prisma.product.findFirst({ where: { ...liveProductWhere(new Date()), slug }, select: { id: true } });
  if (!p) throw notFound("Product");
  return p.id;
}

export const productDetailRoutes: FastifyPluginAsyncZod = async (app) => {
  // ── Product page ────────────────────────────────────────────────────────────
  app.get(
    "/products/:slug",
    { schema: { tags: ["storefront"], params: slugParam, response: { 200: productDetailDto } } },
    async (req) => {
      const detail = await readProductDetail(req.params.slug);
      if (!detail) throw notFound("Product");
      return detail;
    },
  );

  app.get(
    "/products/slugs",
    { schema: { tags: ["storefront"], response: { 200: z.object({ slugs: z.array(z.string()) }) } } },
    async () => ({ slugs: await liveProductSlugs() }),
  );

  // ── Reviews ─────────────────────────────────────────────────────────────────
  app.get(
    "/products/:slug/reviews",
    {
      schema: {
        tags: ["storefront"],
        params: slugParam,
        querystring: z.object({
          page: z.coerce.number().int().min(1).max(500).default(1),
          rating: z.coerce.number().int().min(1).max(5).optional(),
          sort: z.enum(["newest", "highest", "lowest"]).default("newest"),
        }),
        response: { 200: reviewPageDto },
      },
    },
    async (req) => reviewPage(await liveProductIdBySlug(req.params.slug), { page: req.query.page, rating: req.query.rating ?? null, sort: req.query.sort }),
  );

  app.get(
    "/products/:slug/review-eligibility",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["storefront"],
        params: slugParam,
        response: { 200: z.object({ canReview: z.boolean(), reason: z.enum(["ok", "not_purchased", "already_reviewed"]), verified: z.boolean() }) },
      },
    },
    async (req) => {
      const user = await loadAuthUser(req);
      return reviewEligibility(user.id, await liveProductIdBySlug(req.params.slug));
    },
  );

  app.post(
    "/products/:slug/reviews",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["storefront"],
        params: slugParam,
        body: reviewInputSchema,
        response: { 201: z.object({ id: z.string(), status: z.enum(["PENDING", "APPROVED", "REJECTED"]) }) },
      },
    },
    async (req, reply) => {
      const user = await loadAuthUser(req);
      const review = await createReview(user.id, await liveProductIdBySlug(req.params.slug), req.body);
      if (review.status === "APPROVED") revalidateFrontend([TAGS.product(req.params.slug), TAGS.products]);
      return reply.code(201).send(review);
    },
  );

  // ── Watchlist ───────────────────────────────────────────────────────────────
  app.get(
    "/me/watchlist/ids",
    { preHandler: requireAuth, schema: { tags: ["account"], response: { 200: z.object({ productIds: z.array(z.string()) }) } } },
    async (req) => {
      const user = await loadAuthUser(req);
      const rows = await prisma.watchlistItem.findMany({ where: { userId: user.id }, select: { productId: true }, orderBy: { createdAt: "desc" }, take: 500 });
      return { productIds: rows.map((r) => r.productId) };
    },
  );

  app.put(
    "/me/watchlist/:productId",
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } }, schema: { tags: ["account"], params: productIdParam, response: { 204: z.null() } } },
    async (req, reply) => {
      const user = await loadAuthUser(req);
      const exists = await prisma.product.findFirst({ where: { ...liveProductWhere(new Date()), id: req.params.productId }, select: { id: true } });
      if (!exists) throw notFound("Product");
      // createMany + skipDuplicates tells a new watch (count 1) from a repeat.
      const { count } = await prisma.watchlistItem.createMany({ data: [{ userId: user.id, productId: req.params.productId }], skipDuplicates: true });
      if (count) void recordEvents(actorFrom(req), [{ type: "WATCH", productId: req.params.productId }], req.log);
      return reply.code(204).send(null);
    },
  );

  // ── Analytics events from the browser ──────────────────────────────────────
  // Views and shares happen client-side (product pages are cached, so the
  // server never sees them). Guests who press Watch are sent to sign in; that
  // intent is recorded here too (members' watches are recorded by PUT above).
  app.post(
    "/events",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags: ["analytics"],
        body: z.object({ type: z.enum(["VIEW", "SHARE", "WATCH"]), productId: productIdParam.shape.productId }),
        response: { 202: z.object({ recorded: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const actor = actorFrom(req);
      const { type, productId } = req.body;
      if (actor.staff || (type === "WATCH" && actor.userId)) return reply.code(202).send({ recorded: false });
      const live = await prisma.product.findFirst({ where: { ...liveProductWhere(new Date()), id: productId }, select: { id: true } });
      if (!live) return reply.code(202).send({ recorded: false });
      if (type === "VIEW") return reply.code(202).send({ recorded: await recordView(actor, productId, req.log) });
      await recordEvents(actor, [{ type, productId }], req.log);
      return reply.code(202).send({ recorded: true });
    },
  );

  app.delete(
    "/me/watchlist/:productId",
    { preHandler: requireAuth, schema: { tags: ["account"], params: productIdParam, response: { 204: z.null() } } },
    async (req, reply) => {
      const user = await loadAuthUser(req);
      await prisma.watchlistItem.deleteMany({ where: { userId: user.id, productId: req.params.productId } });
      return reply.code(204).send(null);
    },
  );

};
