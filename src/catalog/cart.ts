import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  computeTotals,
  effectivePrice,
  rateAvailable,
  shippingFor,
  type CouponRule,
  type PromotionDiscount,
  type TotalsLine,
} from "../core";
import { prisma } from "../db";
import { HttpError, notFound } from "../lib/errors";
import { readSite } from "../routes/settings";
import { liveProductWhere } from "./product-feed";

/**
 * Carts belong to a signed-in user, or to a guest identified by an opaque token
 * the frontend keeps in an httpOnly cookie. Only a SHA-256 of the token is stored,
 * so a database leak doesn't expose guest carts.
 */
export type CartOwner = { userId: string | null; token: string | null };

export const MAX_LINE_QUANTITY = 10;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function findCart(owner: CartOwner) {
  if (owner.userId) return prisma.cart.findUnique({ where: { userId: owner.userId }, select: { id: true, couponCode: true } });
  if (owner.token) return prisma.cart.findUnique({ where: { guestToken: hashToken(owner.token) }, select: { id: true, couponCode: true } });
  return null;
}

export async function cartItemCount(owner: CartOwner): Promise<number> {
  const cart = await findCart(owner);
  if (!cart) return 0;
  const agg = await prisma.cartItem.aggregate({ where: { cartId: cart.id, savedForLater: false }, _sum: { quantity: true } });
  return agg._sum.quantity ?? 0;
}

// ── Reading the cart ─────────────────────────────────────────────────────────

export const cartLineDto = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.string().nullable(),
  slug: z.string(),
  title: z.string(),
  variantTitle: z.string().nullable(),
  image: z.object({ url: z.string(), alt: z.string() }).nullable(),
  unitPriceCents: z.number().int(),
  compareAtPriceCents: z.number().int().nullable(),
  quantity: z.number().int(),
  maxQuantity: z.number().int(),
  freeShipping: z.boolean(),
  /** False when the item can't be bought right now (removed, out of stock). */
  available: z.boolean(),
  /** Shopper-facing note: why it's unavailable, or that the quantity was lowered. */
  notice: z.string().nullable(),
});
export type CartLine = z.infer<typeof cartLineDto> & { categoryId: string; savedForLater: boolean };

export const cartDto = z.object({
  lines: z.array(cartLineDto),
  saved: z.array(cartLineDto),
  itemCount: z.number().int(),
  coupon: z.object({ code: z.string(), applied: z.boolean(), message: z.string().nullable() }).nullable(),
  totals: z.object({
    subtotalCents: z.number().int(),
    discountCents: z.number().int(),
    /** Estimate to the store's home zone; final shipping is chosen at checkout. */
    shippingCents: z.number().int().nullable(),
    totalCents: z.number().int(),
  }),
  shippingEstimate: z.object({ region: z.string(), method: z.string() }).nullable(),
});

const lineSelect = {
  id: true,
  quantity: true,
  savedForLater: true,
  variantId: true,
  product: {
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      publishAt: true,
      unpublishAt: true,
      priceCents: true,
      compareAtPriceCents: true,
      stock: true,
      trackInventory: true,
      freeShipping: true,
      categoryId: true,
      images: { orderBy: { position: "asc" as const }, take: 1, select: { alt: true, media: { select: { url: true, alt: true } } } },
    },
  },
  variant: { select: { id: true, title: true, priceCents: true, compareAtPriceCents: true, stock: true, isActive: true, image: { select: { url: true, alt: true } } } },
} as const;

/** Active promotions per product (for cart pricing). */
async function activePromotions(productIds: string[], now: Date) {
  const rows = await prisma.promotionProduct.findMany({
    where: { productId: { in: productIds }, promotion: { isActive: true, startsAt: { lte: now }, endsAt: { gt: now } } },
    select: { productId: true, specialPriceCents: true, promotion: { select: { id: true, discountType: true, value: true, endsAt: true } } },
  });
  const map = new Map<string, PromotionDiscount[]>();
  for (const r of rows) {
    const list = map.get(r.productId) ?? [];
    list.push({ promotionId: r.promotion.id, discountType: r.promotion.discountType, value: r.promotion.value, specialPriceCents: r.specialPriceCents, endsAt: r.promotion.endsAt });
    map.set(r.productId, list);
  }
  return map;
}

/**
 * Current lines with live prices and availability. Quantities above stock are
 * lowered in place (and the shopper told), so checkout never oversells.
 */
export async function loadLines(cartId: string, now = new Date()): Promise<CartLine[]> {
  const rows = await prisma.cartItem.findMany({ where: { cartId }, orderBy: { createdAt: "asc" }, select: lineSelect });
  const promos = await activePromotions([...new Set(rows.map((r) => r.product.id))], now);
  const lines: CartLine[] = [];
  for (const r of rows) {
    const p = r.product;
    const live = p.status === "ACTIVE" && (!p.publishAt || p.publishAt <= now) && (!p.unpublishAt || p.unpublishAt > now);
    const variantOk = r.variantId ? Boolean(r.variant?.isActive) : true;
    const stock = r.variant ? r.variant.stock : p.stock;
    const max = p.trackInventory ? Math.min(MAX_LINE_QUANTITY, stock) : MAX_LINE_QUANTITY;
    const price = effectivePrice(
      { priceCents: r.variant?.priceCents ?? p.priceCents, compareAtPriceCents: r.variant?.compareAtPriceCents ?? p.compareAtPriceCents },
      promos.get(p.id) ?? [],
    );
    let quantity = r.quantity;
    let notice: string | null = null;
    const available = live && variantOk && max > 0;
    if (!live || !variantOk) notice = "This item is no longer available.";
    else if (max <= 0) notice = "Out of stock.";
    else if (quantity > max) {
      quantity = max;
      notice = `Only ${max} available, so we lowered your quantity.`;
      await prisma.cartItem.update({ where: { id: r.id }, data: { quantity } });
    }
    const image = r.variant?.image ?? (p.images[0] ? { url: p.images[0].media.url, alt: p.images[0].alt ?? p.images[0].media.alt } : null);
    lines.push({
      id: r.id,
      productId: p.id,
      variantId: r.variantId,
      slug: p.slug,
      title: p.title,
      variantTitle: r.variant?.title ?? null,
      image,
      unitPriceCents: price.priceCents,
      compareAtPriceCents: price.compareAtPriceCents,
      quantity,
      maxQuantity: Math.max(0, max),
      freeShipping: p.freeShipping || price.freeShippingPromo,
      available,
      notice,
      categoryId: p.categoryId,
      savedForLater: r.savedForLater,
    });
  }
  return lines;
}

export const toTotalsLines = (lines: CartLine[]): TotalsLine[] =>
  lines.map((l) => ({ productId: l.productId, categoryId: l.categoryId, unitPriceCents: l.unitPriceCents, quantity: l.quantity, freeShipping: l.freeShipping }));

/** A coupon that's valid right now (dates, active, usage cap), or null with a reason. */
export async function loadCoupon(code: string, now = new Date(), email?: string | null): Promise<{ rule: CouponRule | null; error: string | null }> {
  const c = await prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
  if (!c || !c.isActive) return { rule: null, error: "That code isn't valid." };
  if (c.startsAt && c.startsAt > now) return { rule: null, error: "That code isn't active yet." };
  if (c.endsAt && c.endsAt <= now) return { rule: null, error: "That code has expired." };
  if (c.maxUses !== null && c.usedCount >= c.maxUses) return { rule: null, error: "That code has been fully used." };
  if (email && c.perCustomerLimit !== null) {
    const used = await prisma.order.count({ where: { couponCode: c.code, email: { equals: email, mode: "insensitive" }, status: { not: "CANCELLED" } } });
    if (used >= c.perCustomerLimit) return { rule: null, error: `You've already used ${c.code}.` };
  }
  return {
    rule: { code: c.code, type: c.type, value: c.value, minSubtotalCents: c.minSubtotalCents, scope: c.scope, categoryIds: c.categoryIds, productIds: c.productIds },
    error: null,
  };
}

/** Drops internal fields before sending a line to the storefront. */
const publicLine = ({ categoryId: _categoryId, savedForLater: _saved, ...rest }: CartLine) => rest;

export async function readCart(owner: CartOwner) {
  const empty = { lines: [], saved: [], itemCount: 0, coupon: null, totals: { subtotalCents: 0, discountCents: 0, shippingCents: null, totalCents: 0 }, shippingEstimate: null };
  const cart = await findCart(owner);
  if (!cart) return empty;
  const now = new Date();
  const all = await loadLines(cart.id, now);
  const saved = all.filter((l) => l.savedForLater);
  const lines = all.filter((l) => !l.savedForLater);
  const buyable = lines.filter((l) => l.available);

  const [site, coupon, zone] = await Promise.all([
    readSite(),
    cart.couponCode ? loadCoupon(cart.couponCode, now) : Promise.resolve(null),
    prisma.shippingZone.findFirst({
      orderBy: { position: "asc" },
      select: { name: true, rates: { where: { isActive: true }, orderBy: [{ priceCents: "asc" }, { position: "asc" }], select: { name: true, priceCents: true, freeOverCents: true, minSubtotalCents: true } } },
    }),
  ]);
  const subtotal = buyable.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const rate = zone?.rates.find((r) => rateAvailable(r, subtotal));
  const tl = toTotalsLines(buyable);
  const shipping = rate ? shippingFor(rate, tl, subtotal, true) : null;
  const totals = computeTotals({ lines: tl, coupon: coupon?.rule ?? null, shippingCents: shipping, tax: null, money: site });

  return {
    lines: lines.map(publicLine),
    saved: saved.map(publicLine),
    itemCount: lines.reduce((s, l) => s + l.quantity, 0),
    coupon: cart.couponCode ? (coupon?.error ? { code: cart.couponCode, applied: false, message: coupon.error } : totals.coupon) : null,
    totals: { subtotalCents: totals.subtotalCents, discountCents: totals.discountCents, shippingCents: buyable.length ? totals.shippingCents : null, totalCents: totals.totalCents },
    shippingEstimate: zone && rate && buyable.length ? { region: zone.name, method: rate.name } : null,
  };
}

// ── Changing the cart ────────────────────────────────────────────────────────

async function ensureCart(owner: CartOwner): Promise<{ id: string; newToken: string | null }> {
  const existing = await findCart(owner);
  if (existing) return { id: existing.id, newToken: null };
  if (owner.userId) return { id: (await prisma.cart.create({ data: { userId: owner.userId }, select: { id: true } })).id, newToken: null };
  const token = randomBytes(32).toString("base64url");
  const cart = await prisma.cart.create({ data: { guestToken: hashToken(token) }, select: { id: true } });
  return { id: cart.id, newToken: token };
}

async function stockFor(productId: string, variantId: string | null) {
  const product = await prisma.product.findFirst({
    where: { ...liveProductWhere(new Date()), id: productId },
    select: { stock: true, trackInventory: true, variants: { where: { isActive: true }, select: { id: true, stock: true } } },
  });
  if (!product) throw notFound("Product");
  if (product.variants.length) {
    const v = product.variants.find((x) => x.id === variantId);
    if (!v) throw new HttpError(400, "variant_required", "Choose an option before adding to your cart.");
    return { tracked: product.trackInventory, available: v.stock };
  }
  if (variantId) throw new HttpError(400, "invalid_variant", "That option isn't available.");
  return { tracked: product.trackInventory, available: product.stock };
}

function checkQuantity(quantity: number, stock: { tracked: boolean; available: number }, alreadyInCart = 0) {
  if (stock.tracked && quantity > stock.available) {
    const left = Math.max(0, stock.available - alreadyInCart);
    throw new HttpError(
      409,
      "insufficient_stock",
      stock.available === 0 ? "Sorry, this is out of stock." : left === 0 ? `You already have all ${stock.available} in your cart.` : `Only ${stock.available} available.`,
    );
  }
  if (quantity > MAX_LINE_QUANTITY) throw new HttpError(409, "quantity_limit", `You can buy up to ${MAX_LINE_QUANTITY} of this item per order.`);
}

/** Adds to the cart, merging with an existing line. Returns a new guest token when a guest cart was created. */
export async function addToCart(owner: CartOwner, input: { productId: string; variantId?: string | null; quantity: number }) {
  const variantId = input.variantId ?? null;
  const stock = await stockFor(input.productId, variantId);
  const cart = await ensureCart(owner);
  const existing = await prisma.cartItem.findFirst({ where: { cartId: cart.id, productId: input.productId, variantId, savedForLater: false }, select: { id: true, quantity: true } });
  const next = (existing?.quantity ?? 0) + input.quantity;
  checkQuantity(next, stock, existing?.quantity ?? 0);
  if (existing) await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: next } });
  else await prisma.cartItem.create({ data: { cartId: cart.id, productId: input.productId, variantId, quantity: input.quantity } });
  await prisma.cart.update({ where: { id: cart.id }, data: { updatedAt: new Date() } });
  const resolved: CartOwner = owner.userId ? owner : { userId: null, token: cart.newToken ?? owner.token };
  return { cartToken: cart.newToken, itemCount: await cartItemCount(resolved) };
}

async function ownedLine(owner: CartOwner, lineId: string) {
  const cart = await findCart(owner);
  const line = cart ? await prisma.cartItem.findFirst({ where: { id: lineId, cartId: cart.id }, select: { id: true, productId: true, variantId: true, savedForLater: true, quantity: true, cartId: true } }) : null;
  if (!line) throw notFound("Cart item");
  return line;
}

export async function updateLine(owner: CartOwner, lineId: string, quantity: number) {
  const line = await ownedLine(owner, lineId);
  checkQuantity(quantity, await stockFor(line.productId, line.variantId));
  await prisma.cartItem.update({ where: { id: line.id }, data: { quantity } });
}

export async function removeLine(owner: CartOwner, lineId: string) {
  const line = await ownedLine(owner, lineId);
  await prisma.cartItem.delete({ where: { id: line.id } });
}

/** Moves a line between the cart and "Saved for later" (merging with an identical line). */
export async function setSavedForLater(owner: CartOwner, lineId: string, saved: boolean) {
  const line = await ownedLine(owner, lineId);
  if (line.savedForLater === saved) return;
  const twin = await prisma.cartItem.findFirst({ where: { cartId: line.cartId, productId: line.productId, variantId: line.variantId, savedForLater: saved }, select: { id: true, quantity: true } });
  if (twin) {
    await prisma.$transaction([
      prisma.cartItem.update({ where: { id: twin.id }, data: { quantity: Math.min(MAX_LINE_QUANTITY, twin.quantity + line.quantity) } }),
      prisma.cartItem.delete({ where: { id: line.id } }),
    ]);
  } else {
    await prisma.cartItem.update({ where: { id: line.id }, data: { savedForLater: saved } });
  }
}

export async function setCoupon(owner: CartOwner, code: string | null) {
  const cart = await findCart(owner);
  if (!cart) throw new HttpError(400, "empty_cart", "Add something to your cart first.");
  if (code) {
    const { error, rule } = await loadCoupon(code);
    if (error || !rule) throw new HttpError(400, "invalid_coupon", error ?? "That code isn't valid.", { code: [error ?? "That code isn't valid."] });
    await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: rule.code } });
  } else {
    await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
  }
}

/**
 * On sign-in, a guest cart's lines move into the account cart (quantities merged
 * up to stock and the per-line cap); the guest cart is then deleted.
 */
export async function mergeGuestCart(userId: string, guestToken: string) {
  const guest = await prisma.cart.findUnique({ where: { guestToken: hashToken(guestToken) }, select: { id: true, couponCode: true, items: { select: { productId: true, variantId: true, quantity: true, savedForLater: true } } } });
  if (!guest) return { merged: 0 };
  const target = await ensureCart({ userId, token: null });
  let merged = 0;
  for (const item of guest.items) {
    const existing = await prisma.cartItem.findFirst({ where: { cartId: target.id, productId: item.productId, variantId: item.variantId, savedForLater: item.savedForLater }, select: { id: true, quantity: true } });
    const quantity = Math.min(MAX_LINE_QUANTITY, (existing?.quantity ?? 0) + item.quantity);
    if (existing) await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity } });
    else await prisma.cartItem.create({ data: { cartId: target.id, productId: item.productId, variantId: item.variantId, quantity, savedForLater: item.savedForLater } });
    merged++;
  }
  if (guest.couponCode) {
    await prisma.cart.updateMany({ where: { id: target.id, couponCode: null }, data: { couponCode: guest.couponCode } });
  }
  await prisma.cart.delete({ where: { id: guest.id } });
  return { merged };
}
