import type { z } from "zod";
import { formatOrderNumber, slugify, type ContentPageInput, type CouponInput, type PromotionInput, type reviewListQuery } from "../core";
import { refreshProductRating } from "../catalog/reviews";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { HttpError, notFound } from "../lib/errors";
import { uniqueSlug } from "./util";

const iso = (d: Date | null) => d?.toISOString() ?? null;
const stateOf = (p: { isActive: boolean; startsAt: Date | null; endsAt: Date | null }, now: Date) =>
  !p.isActive ? "off" : p.startsAt && p.startsAt > now ? "scheduled" : p.endsAt && p.endsAt <= now ? "ended" : "live";

// ── Promotions ───────────────────────────────────────────────────────────────

export async function listPromotions() {
  const now = new Date();
  const rows = await prisma.promotion.findMany({ orderBy: [{ startsAt: "desc" }], include: { _count: { select: { products: true } } } });
  return rows.map(({ _count, ...p }) => ({ ...p, startsAt: p.startsAt.toISOString(), endsAt: p.endsAt.toISOString(), createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), productCount: _count.products, state: stateOf(p, now) }));
}

export async function readPromotion(id: string) {
  const p = await prisma.promotion.findUnique({
    where: { id },
    include: { products: { include: { product: { select: { id: true, title: true, priceCents: true, status: true, images: { take: 1, orderBy: { position: "asc" }, select: { media: { select: { url: true } } } } } } } } },
  });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    discountType: p.discountType as "PERCENT" | "FIXED",
    value: p.value,
    startsAt: p.startsAt.toISOString(),
    endsAt: p.endsAt.toISOString(),
    isActive: p.isActive,
    products: p.products.map((x) => ({ productId: x.productId, specialPriceCents: x.specialPriceCents, title: x.product.title, priceCents: x.product.priceCents, status: x.product.status, imageUrl: x.product.images[0]?.media.url ?? null })),
  };
}

export async function savePromotion(id: string | null, input: PromotionInput) {
  const ids = input.products.map((p) => p.productId);
  const found = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, priceCents: true } });
  if (found.length !== ids.length) throw new HttpError(422, "validation_error", "Some products no longer exist. Remove them and try again.", { products: ["Some products no longer exist."] });
  // A special price must actually be a discount.
  const price = new Map(found.map((p) => [p.id, p.priceCents]));
  const bad = input.products.findIndex((p) => p.specialPriceCents !== null && p.specialPriceCents >= price.get(p.productId)!);
  if (bad >= 0) throw new HttpError(422, "validation_error", "A special price must be lower than the regular price.", { [`products.${bad}.specialPriceCents`]: ["Must be lower than the regular price."] });

  const { products, ...data } = input;
  const rows = products.map((p) => ({ productId: p.productId, specialPriceCents: p.specialPriceCents }));
  if (id) {
    const before = await prisma.promotion.findUnique({ where: { id }, select: { id: true } });
    if (!before) throw notFound("Promotion");
    await prisma.$transaction([prisma.promotion.update({ where: { id }, data }), prisma.promotionProduct.deleteMany({ where: { promotionId: id } }), prisma.promotionProduct.createMany({ data: rows.map((r) => ({ ...r, promotionId: id })) })]);
    return { id, name: input.name };
  }
  const created = await prisma.promotion.create({ data: { ...data, products: { createMany: { data: rows } } }, select: { id: true, name: true } });
  return created;
}

export async function deletePromotion(id: string) {
  const p = await prisma.promotion.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!p) throw notFound("Promotion");
  await prisma.promotion.delete({ where: { id } });
  return p;
}

// ── Coupons ──────────────────────────────────────────────────────────────────

export async function listCoupons() {
  const now = new Date();
  const rows = await prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map((c) => ({ ...c, startsAt: iso(c.startsAt), endsAt: iso(c.endsAt), createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(), state: c.maxUses !== null && c.usedCount >= c.maxUses ? "used up" : stateOf(c, now) }));
}

export async function saveCoupon(id: string | null, input: CouponInput) {
  const data = {
    ...input,
    value: input.type === "FREE_SHIPPING" ? 0 : input.value,
    categoryIds: input.scope === "CATEGORIES" ? input.categoryIds : [],
    productIds: input.scope === "PRODUCTS" ? input.productIds : [],
  };
  const clash = await prisma.coupon.findFirst({ where: { code: data.code, ...(id ? { NOT: { id } } : {}) }, select: { id: true } });
  if (clash) throw new HttpError(409, "already_exists", "That code is already used.", { code: ["Another coupon uses this code."] });
  if (id) {
    const before = await prisma.coupon.findUnique({ where: { id } });
    if (!before) throw notFound("Coupon");
    // Orders store the code; renaming a used coupon would break that link.
    if (before.usedCount > 0 && before.code !== data.code) throw new HttpError(409, "code_in_use", "This code has been used on orders, so it can't be renamed. Create a new coupon instead.", { code: ["Used on orders; can't be renamed."] });
    await prisma.coupon.update({ where: { id }, data });
    return { id, code: data.code, before };
  }
  const c = await prisma.coupon.create({ data, select: { id: true, code: true } });
  return { ...c, before: null };
}

export async function deleteCoupon(id: string) {
  const c = await prisma.coupon.findUnique({ where: { id }, select: { id: true, code: true, usedCount: true } });
  if (!c) throw notFound("Coupon");
  if (c.usedCount > 0) throw new HttpError(409, "in_use", `${c.code} has been used on ${c.usedCount} ${c.usedCount === 1 ? "order" : "orders"}. Switch it off instead, so order history keeps making sense.`);
  await prisma.coupon.delete({ where: { id } });
  return c;
}

// ── Reviews ──────────────────────────────────────────────────────────────────

export async function listReviews(q: z.infer<typeof reviewListQuery>) {
  const pageSize = 25;
  const where: Prisma.ReviewWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.rating ? { rating: q.rating } : {}),
    ...(q.q ? { OR: [{ authorName: { contains: q.q, mode: "insensitive" } }, { body: { contains: q.q, mode: "insensitive" } }, { product: { title: { contains: q.q, mode: "insensitive" } } }] } : {}),
  };
  const [rows, total, counts] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * pageSize,
      take: pageSize,
      include: { product: { select: { id: true, title: true, slug: true } }, user: { select: { id: true, email: true } }, images: { orderBy: { position: "asc" }, include: { media: { select: { url: true, alt: true } } } } },
    }),
    prisma.review.count({ where }),
    prisma.review.groupBy({ by: ["status"], _count: true }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      authorName: r.authorName,
      authorEmail: r.user?.email ?? null,
      customerId: r.user?.id ?? null,
      isVerified: r.isVerified,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      product: r.product,
      images: r.images.map((i) => i.media),
    })),
    total,
    page: q.page,
    pageSize,
    counts: Object.fromEntries(["PENDING", "APPROVED", "REJECTED"].map((s) => [s, counts.find((c) => c.status === s)?._count ?? 0])),
  };
}

/** Approve, reject or delete reviews, then refresh the affected products' ratings. */
export async function moderateReviews(ids: string[], action: "approve" | "reject" | "delete") {
  const reviews = await prisma.review.findMany({ where: { id: { in: ids } }, select: { id: true, productId: true, product: { select: { slug: true } } } });
  if (!reviews.length) throw notFound("Review");
  const found = reviews.map((r) => r.id);
  if (action === "delete") await prisma.review.deleteMany({ where: { id: { in: found } } });
  else await prisma.review.updateMany({ where: { id: { in: found } }, data: { status: action === "approve" ? "APPROVED" : "REJECTED" } });
  const products = [...new Map(reviews.map((r) => [r.productId, r.product.slug])).entries()];
  for (const [productId] of products) await refreshProductRating(productId);
  return { count: found.length, slugs: products.map(([, slug]) => slug) };
}

// ── Content & landing pages ──────────────────────────────────────────────────

export async function readContentPage(id: string) {
  const p = await prisma.page.findUnique({ where: { id }, select: { id: true, slug: true, title: true, kind: true, status: true, content: true, seoTitle: true, seoDescription: true, publishedAt: true, updatedAt: true } });
  if (!p || p.kind === "HOME") return null;
  return { ...p, publishedAt: iso(p.publishedAt), updatedAt: p.updatedAt.toISOString() };
}

export async function saveContentPage(id: string | null, input: ContentPageInput) {
  const taken = (exceptId: string | null) => async (slug: string) => Boolean(await prisma.page.findFirst({ where: { slug, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { id: true } }));
  const slug = input.slug ?? (await uniqueSlug(slugify(input.title), taken(id)));
  if (input.slug && (await taken(id)(input.slug))) throw new HttpError(409, "already_exists", "Another page uses that address.", { slug: ["Already used by another page."] });
  const data = {
    title: input.title,
    slug,
    status: input.status,
    content: (input.content ?? undefined) as Prisma.InputJsonValue | undefined,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
  };
  if (id) {
    const before = await prisma.page.findUnique({ where: { id }, select: { kind: true, slug: true, status: true, publishedAt: true } });
    if (!before || before.kind === "HOME") throw notFound("Page");
    await prisma.page.update({ where: { id }, data: { ...data, ...(input.status === "PUBLISHED" && before.status !== "PUBLISHED" ? { publishedAt: new Date() } : {}) } });
    return { id, slug, oldSlug: before.slug };
  }
  const p = await prisma.page.create({ data: { ...data, kind: input.kind, ...(input.status === "PUBLISHED" ? { publishedAt: new Date() } : {}) }, select: { id: true, slug: true } });
  return { id: p.id, slug: p.slug, oldSlug: null };
}

export async function deleteContentPage(id: string) {
  const p = await prisma.page.findUnique({ where: { id }, select: { id: true, slug: true, title: true, kind: true } });
  if (!p || p.kind === "HOME") throw notFound("Page");
  await prisma.page.delete({ where: { id } });
  return p;
}

// ── Audit log ────────────────────────────────────────────────────────────────

export async function listAudit(q: { q?: string; entity?: string; actorId?: string; from?: string; to?: string; page: number }) {
  const pageSize = 50;
  const where: Prisma.AuditLogWhereInput = {
    ...(q.entity ? { entity: q.entity } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.q ? { OR: [{ summary: { contains: q.q, mode: "insensitive" } }, { action: { contains: q.q, mode: "insensitive" } }] } : {}),
    ...(q.from || q.to
      ? { createdAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000) } : {}) } }
      : {}),
  };
  const [rows, total, entities, actors] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * pageSize, take: pageSize, include: { actor: { select: { id: true, name: true, email: true } } } }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ distinct: ["entity"], select: { entity: true }, orderBy: { entity: "asc" } }),
    prisma.user.findMany({ where: { auditLogs: { some: {} } }, select: { id: true, name: true, email: true }, orderBy: { email: "asc" } }),
  ]);
  return {
    items: rows.map((r) => ({ id: r.id, action: r.action, entity: r.entity, entityId: r.entityId, summary: r.summary, diff: r.diff, ip: r.ip, createdAt: r.createdAt.toISOString(), actor: r.actor ? { id: r.actor.id, name: r.actor.name ?? r.actor.email } : null })),
    total,
    page: q.page,
    pageSize,
    entities: entities.map((e) => e.entity),
    actors: actors.map((a) => ({ id: a.id, name: a.name ?? a.email })),
  };
}

// ── Dashboard ────────────────────────────────────────────────────────────────

/** Sales KPIs for the last `days` days vs the period before, a daily revenue series, and work queues. */
export async function dashboardStats(days: number) {
  const now = new Date();
  const dayMs = 86_400_000;
  const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(startToday.getTime() - (days - 1) * dayMs);
  const prevFrom = new Date(from.getTime() - days * dayMs);
  const counted = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"] as const;

  const [series, prev, topProducts, lowStock, recent, pendingReviews, toShip, unpaid] = await Promise.all([
    prisma.$queryRaw<Array<{ day: Date; revenue: bigint; orders: bigint }>>`
      SELECT date_trunc('day', "placedAt" AT TIME ZONE 'UTC') AS day, coalesce(sum("totalCents"), 0) AS revenue, count(*) AS orders
      FROM "Order" WHERE "placedAt" >= ${from} AND status::text IN ('PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED')
      GROUP BY 1 ORDER BY 1`,
    prisma.order.aggregate({ where: { placedAt: { gte: prevFrom, lt: from }, status: { in: [...counted] } }, _sum: { totalCents: true }, _count: true }),
    prisma.orderItem.groupBy({
      by: ["productId", "title"],
      where: { productId: { not: null }, order: { placedAt: { gte: from }, status: { in: [...counted] } } },
      _sum: { quantity: true, totalCents: true },
      orderBy: { _sum: { totalCents: "desc" } },
      take: 5,
    }),
    prisma.$queryRaw<Array<{ id: string; title: string; stock: bigint; threshold: number }>>`
      SELECT p.id, p.title, coalesce(v.stock, p.stock) AS stock, p."lowStockThreshold" AS threshold
      FROM "Product" p
      LEFT JOIN (SELECT "productId", sum(stock) AS stock FROM "ProductVariant" WHERE "isActive" GROUP BY 1) v ON v."productId" = p.id
      WHERE p.status = 'ACTIVE' AND p."trackInventory" AND coalesce(v.stock, p.stock) <= p."lowStockThreshold"
      ORDER BY 3 ASC, p.title LIMIT 8`,
    prisma.order.findMany({ orderBy: { placedAt: "desc" }, take: 6, select: { id: true, orderNo: true, status: true, totalCents: true, currency: true, placedAt: true, email: true, shippingAddress: true } }),
    prisma.review.count({ where: { status: "PENDING" } }),
    prisma.order.count({ where: { status: "CONFIRMED" } }),
    prisma.order.count({ where: { status: { notIn: ["CANCELLED", "REFUNDED"] }, payments: { some: { status: "PENDING" } } } }),
  ]);

  const byDay = new Map(series.map((r) => [r.day.toISOString().slice(0, 10), r]));
  const points = Array.from({ length: days }, (_, i) => {
    const d = new Date(from.getTime() + i * dayMs).toISOString().slice(0, 10);
    const r = byDay.get(d);
    return { date: d, revenueCents: Number(r?.revenue ?? 0), orders: Number(r?.orders ?? 0) };
  });
  const revenue = points.reduce((s, p) => s + p.revenueCents, 0);
  const orders = points.reduce((s, p) => s + p.orders, 0);
  const prevRevenue = prev._sum.totalCents ?? 0;
  const prevOrders = prev._count;
  return {
    days,
    revenue: { cents: revenue, previousCents: prevRevenue },
    orders: { count: orders, previous: prevOrders },
    averageOrder: { cents: orders ? Math.round(revenue / orders) : 0, previousCents: prevOrders ? Math.round(prevRevenue / prevOrders) : 0 },
    series: points,
    topProducts: topProducts.map((t) => ({ productId: t.productId!, title: t.title, quantity: t._sum.quantity ?? 0, revenueCents: t._sum.totalCents ?? 0 })),
    lowStock: lowStock.map((l) => ({ id: l.id, title: l.title, stock: Number(l.stock), threshold: l.threshold })),
    recentOrders: recent.map((o) => ({ id: o.id, number: formatOrderNumber(o.orderNo), status: o.status, totalCents: o.totalCents, currency: o.currency, placedAt: o.placedAt.toISOString(), customer: (o.shippingAddress as { fullName?: string } | null)?.fullName ?? o.email })),
    queues: { pendingReviews, toShip, unpaid },
  };
}
