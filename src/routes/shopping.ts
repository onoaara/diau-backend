import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { authResponseSchema, registerSchema } from "../core";
import {
  addToCart,
  cartDto,
  cartItemCount,
  cartLineDto,
  MAX_LINE_QUANTITY,
  mergeGuestCart,
  readCart,
  removeLine,
  setCoupon,
  setSavedForLater,
  updateLine,
  type CartLine,
  type CartOwner,
} from "../catalog/cart";
import { productCardDto, productsByIds } from "../catalog/product-feed";
import { addressSchema, placeOrderSchema, placeOrder, quote, quoteInputSchema } from "../checkout/checkout";
import { claimGuestOrder, listOrders, orderDto, readOrder } from "../checkout/orders";
import { prisma } from "../db";
import { notFound } from "../lib/errors";
import { loadAuthUser, requireAuth } from "../plugins/auth";
import { issue, userSelect } from "./auth";

const idParam = z.object({ id: z.string().regex(/^[a-z0-9]{10,40}$/i) });

/** Signed-in users own their cart; guests send the cart token the frontend keeps in an httpOnly cookie. */
async function cartOwner(req: FastifyRequest): Promise<CartOwner> {
  if (req.auth) return { userId: (await loadAuthUser(req)).id, token: null };
  const token = req.headers["x-cart-token"];
  return { userId: null, token: typeof token === "string" && /^[A-Za-z0-9_-]{40,60}$/.test(token) ? token : null };
}

const publicLine = ({ categoryId: _c, savedForLater: _s, ...rest }: CartLine) => rest;

const quoteDto = z.object({
  lines: z.array(cartLineDto),
  unavailable: z.array(cartLineDto),
  rates: z.array(z.object({ id: z.string(), name: z.string(), priceCents: z.number().int(), etaMinDays: z.number().int(), etaMaxDays: z.number().int() })),
  rateId: z.string().nullable(),
  totals: z.object({
    subtotalCents: z.number().int(),
    discountCents: z.number().int(),
    shippingCents: z.number().int(),
    taxCents: z.number().int(),
    totalCents: z.number().int(),
    coupon: z.object({ code: z.string(), applied: z.boolean(), message: z.string().nullable() }).nullable(),
  }),
  tax: z.object({ name: z.string(), rateBps: z.number().int() }).nullable(),
  paymentMethods: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
  shipsTo: z.boolean(),
});

const savedAddressDto = addressSchema.extend({ id: z.string(), isDefault: z.boolean() });

export const shoppingRoutes: FastifyPluginAsyncZod = async (app) => {
  // ── Cart ────────────────────────────────────────────────────────────────────
  app.get("/cart", { schema: { tags: ["cart"], response: { 200: cartDto } } }, async (req) => readCart(await cartOwner(req)));

  app.get(
    "/cart/count",
    { schema: { tags: ["cart"], response: { 200: z.object({ itemCount: z.number().int() }) } } },
    async (req) => ({ itemCount: await cartItemCount(await cartOwner(req)) }),
  );

  app.post(
    "/cart/items",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["cart"],
        body: z.object({
          productId: z.string().regex(/^[a-z0-9]{10,40}$/i),
          variantId: z.string().regex(/^[a-z0-9]{10,40}$/i).nullish(),
          quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
        }),
        response: { 201: z.object({ cartToken: z.string().nullable(), itemCount: z.number().int() }) },
      },
    },
    async (req, reply) => reply.code(201).send(await addToCart(await cartOwner(req), req.body)),
  );

  app.patch(
    "/cart/items/:id",
    { schema: { tags: ["cart"], params: idParam, body: z.object({ quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY) }), response: { 200: cartDto } } },
    async (req) => {
      const owner = await cartOwner(req);
      await updateLine(owner, req.params.id, req.body.quantity);
      return readCart(owner);
    },
  );

  app.delete("/cart/items/:id", { schema: { tags: ["cart"], params: idParam, response: { 200: cartDto } } }, async (req) => {
    const owner = await cartOwner(req);
    await removeLine(owner, req.params.id);
    return readCart(owner);
  });

  app.post(
    "/cart/items/:id/saved",
    { schema: { tags: ["cart"], params: idParam, body: z.object({ saved: z.boolean() }), response: { 200: cartDto } } },
    async (req) => {
      const owner = await cartOwner(req);
      await setSavedForLater(owner, req.params.id, req.body.saved);
      return readCart(owner);
    },
  );

  app.put(
    "/cart/coupon",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { tags: ["cart"], body: z.object({ code: z.string().trim().min(1, "Enter a code.").max(40) }), response: { 200: cartDto } },
    },
    async (req) => {
      const owner = await cartOwner(req);
      await setCoupon(owner, req.body.code);
      return readCart(owner);
    },
  );

  app.delete("/cart/coupon", { schema: { tags: ["cart"], response: { 200: cartDto } } }, async (req) => {
    const owner = await cartOwner(req);
    await setCoupon(owner, null);
    return readCart(owner);
  });

  app.post(
    "/cart/merge",
    {
      preHandler: requireAuth,
      schema: { tags: ["cart"], body: z.object({ guestToken: z.string().regex(/^[A-Za-z0-9_-]{40,60}$/) }), response: { 200: z.object({ merged: z.number().int() }) } },
    },
    async (req) => mergeGuestCart((await loadAuthUser(req)).id, req.body.guestToken),
  );

  // ── Checkout ────────────────────────────────────────────────────────────────
  app.post(
    "/checkout/quote",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, schema: { tags: ["checkout"], body: quoteInputSchema, response: { 200: quoteDto } } },
    async (req) => {
      const q = await quote(await cartOwner(req), req.body);
      return { ...q, lines: q.lines.map(publicLine), unavailable: q.unavailable.map(publicLine) };
    },
  );

  app.post(
    "/checkout/orders",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["checkout"],
        body: placeOrderSchema,
        response: { 201: z.object({ orderId: z.string(), orderNumber: z.string(), accessToken: z.string().nullable(), replay: z.boolean() }) },
      },
    },
    async (req, reply) => reply.code(201).send(await placeOrder(await cartOwner(req), req.body)),
  );

  // ── Orders ──────────────────────────────────────────────────────────────────
  app.get(
    "/orders/:id",
    {
      schema: {
        tags: ["orders"],
        params: idParam,
        querystring: z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/).optional() }),
        response: { 200: orderDto },
      },
    },
    async (req) => {
      const userId = req.auth ? (await loadAuthUser(req)).id : null;
      const order = await readOrder(req.params.id, { userId, key: req.query.key ?? null });
      if (!order) throw notFound("Order");
      return order;
    },
  );

  app.post(
    "/orders/:id/claim",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["orders"],
        params: idParam,
        body: z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/), password: registerSchema.shape.password }),
        response: { 201: authResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = await claimGuestOrder(req.params.id, req.body.key, req.body.password);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: userSelect });
      return reply.code(201).send(await issue(user));
    },
  );

  // ── Account ─────────────────────────────────────────────────────────────────
  app.get(
    "/me/orders",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["account"],
        response: {
          200: z.object({
            orders: z.array(
              z.object({
                id: z.string(),
                number: z.string(),
                status: z.string(),
                placedAt: z.string(),
                totalCents: z.number().int(),
                currency: z.string(),
                itemCount: z.number().int(),
                items: z.array(z.object({ title: z.string(), imageUrl: z.string().nullable(), quantity: z.number().int() })),
              }),
            ),
          }),
        },
      },
    },
    async (req) => ({ orders: await listOrders((await loadAuthUser(req)).id) }),
  );

  app.get(
    "/me/watchlist",
    { preHandler: requireAuth, schema: { tags: ["account"], response: { 200: z.object({ items: z.array(productCardDto) }) } } },
    async (req) => {
      const user = await loadAuthUser(req);
      const rows = await prisma.watchlistItem.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 200, select: { productId: true } });
      return { items: await productsByIds(rows.map((r) => r.productId)) };
    },
  );

  app.get(
    "/me/addresses",
    { preHandler: requireAuth, schema: { tags: ["account"], response: { 200: z.object({ addresses: z.array(savedAddressDto) }) } } },
    async (req) => {
      const user = await loadAuthUser(req);
      const rows = await prisma.address.findMany({ where: { userId: user.id }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] });
      return {
        addresses: rows.map((a) => ({
          id: a.id,
          isDefault: a.isDefault,
          fullName: a.fullName,
          line1: a.line1,
          line2: a.line2 ?? "",
          city: a.city,
          region: a.region ?? "",
          postalCode: a.postalCode,
          country: a.country.trim(),
          phone: a.phone ?? "",
        })),
      };
    },
  );
};
