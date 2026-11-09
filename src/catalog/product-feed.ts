import { z } from "zod";
import { effectivePrice, type ProductSource, type PromotionDiscount } from "../core";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";

/** What a product card needs (DESIGN.md §5.4), with promotion pricing applied. */
export const productCardDto = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  priceCents: z.number().int(),
  compareAtPriceCents: z.number().int().nullable(),
  image: z.object({ url: z.string(), alt: z.string() }).nullable(),
  /** Second image, cross-faded in on hover. */
  hoverImage: z.object({ url: z.string(), alt: z.string() }).nullable(),
  ratingAvg: z.number(),
  ratingCount: z.number().int(),
  freeShipping: z.boolean(),
  inStock: z.boolean(),
  /** Shown only in list view (DESIGN.md �6.2). */
  condition: z.enum(["NEW", "USED", "REFURBISHED"]),
  location: z.string().nullable(),
});
export type ProductCardDto = z.infer<typeof productCardDto>;

export const productPageDto = z.object({
  items: z.array(productCardDto),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  hasMore: z.boolean(),
});

/** Products shoppers may see at `now` (status + publish window). */
export function liveProductWhere(now: Date): Prisma.ProductWhereInput {
  return {
    status: "ACTIVE",
    AND: [
      { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
      { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
    ],
  };
}

export function activePromotionWhere(now: Date): Prisma.PromotionWhereInput {
  return { isActive: true, startsAt: { lte: now }, endsAt: { gt: now } };
}

/** A visible category and all its visible descendants. */
export async function categoryWithDescendants(categoryId: string, includeChildren = true): Promise<string[]> {
  if (!includeChildren) return [categoryId];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE scope AS (
      SELECT id FROM "Category" WHERE id = ${categoryId} AND "isVisible"
      UNION ALL
      SELECT c.id FROM "Category" c JOIN scope s ON c."parentId" = s.id WHERE c."isVisible"
    )
    SELECT id FROM scope`;
  return rows.map((r) => r.id);
}

const cardSelect = {
  id: true,
  slug: true,
  title: true,
  priceCents: true,
  compareAtPriceCents: true,
  ratingAvg: true,
  ratingCount: true,
  freeShipping: true,
  stock: true,
  trackInventory: true,
  condition: true,
  location: true,
  images: { orderBy: { position: "asc" }, take: 2, select: { alt: true, media: { select: { url: true, alt: true } } } },
  variants: { where: { isActive: true }, select: { stock: true } },
} satisfies Prisma.ProductSelect;
type CardRow = Prisma.ProductGetPayload<{ select: typeof cardSelect }>;

type Plan = { where: Prisma.ProductWhereInput; orderBy: Prisma.ProductOrderByWithRelationInput[]; manualOrder?: string[] };

/** Translates an admin-configured source into a query. Null = nothing to show. */
async function planFor(source: ProductSource, now: Date): Promise<Plan | null> {
  const live = liveProductWhere(now);
  const popular: Prisma.ProductOrderByWithRelationInput[] = [{ soldCount: "desc" }, { id: "asc" }];
  const inCategory = async (categoryId: string | undefined, includeChildren = true) =>
    categoryId ? { categoryId: { in: await categoryWithDescendants(categoryId, includeChildren) } } : {};

  switch (source.kind) {
    case "manual":
      if (!source.productIds.length) return null;
      return { where: { ...live, id: { in: source.productIds } }, orderBy: [], manualOrder: source.productIds };
    case "category":
      return { where: { ...live, ...(await inCategory(source.categoryId, source.includeChildren)) }, orderBy: popular };
    case "tag":
      return { where: { ...live, tags: { some: { slug: source.tagSlug } } }, orderBy: popular };
    case "brand":
      return { where: { ...live, brandId: source.brandId }, orderBy: popular };
    case "promotion":
      return {
        where: { ...live, promotions: { some: { promotionId: source.promotionId, promotion: activePromotionWhere(now) } } },
        orderBy: popular,
      };
    case "best-sellers":
      return { where: { ...live, ...(await inCategory(source.categoryId)) }, orderBy: popular };
    case "newest":
      return { where: { ...live, ...(await inCategory(source.categoryId)) }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] };
    case "on-sale":
      return {
        where: {
          ...live,
          ...(await inCategory(source.categoryId)),
          OR: [
            { compareAtPriceCents: { gt: prisma.product.fields.priceCents } },
            { promotions: { some: { promotion: activePromotionWhere(now) } } },
          ],
        },
        orderBy: popular,
      };
    case "top-rated":
      return {
        where: { ...live, ...(await inCategory(source.categoryId)), ratingCount: { gte: 3 } },
        orderBy: [{ ratingAvg: "desc" }, { ratingCount: "desc" }, { id: "asc" }],
      };
    case "recently-viewed":
      // Per shopper: the browser asks for its own ids via /products/by-ids.
      return null;
  }
}

/** Active promotions per product, for pricing. */
async function promotionsFor(productIds: string[], now: Date): Promise<Map<string, PromotionDiscount[]>> {
  const map = new Map<string, PromotionDiscount[]>();
  if (!productIds.length) return map;
  const rows = await prisma.promotionProduct.findMany({
    where: { productId: { in: productIds }, promotion: activePromotionWhere(now) },
    select: {
      productId: true,
      specialPriceCents: true,
      promotion: { select: { id: true, discountType: true, value: true, endsAt: true } },
    },
  });
  for (const r of rows) {
    const list = map.get(r.productId) ?? [];
    list.push({
      promotionId: r.promotion.id,
      discountType: r.promotion.discountType,
      value: r.promotion.value,
      specialPriceCents: r.specialPriceCents,
      endsAt: r.promotion.endsAt,
    });
    map.set(r.productId, list);
  }
  return map;
}

function toCard(row: CardRow, promos: PromotionDiscount[]): ProductCardDto {
  const price = effectivePrice(row, promos);
  const [first, second] = row.images;
  const img = (i: (typeof row.images)[number] | undefined) => (i ? { url: i.media.url, alt: i.alt ?? i.media.alt } : null);
  const inStock = !row.trackInventory || (row.variants.length ? row.variants.some((v) => v.stock > 0) : row.stock > 0);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    priceCents: price.priceCents,
    compareAtPriceCents: price.compareAtPriceCents,
    image: img(first),
    hoverImage: img(second),
    ratingAvg: Math.round(row.ratingAvg * 10) / 10,
    ratingCount: row.ratingCount,
    freeShipping: row.freeShipping || price.freeShippingPromo,
    inStock,
    condition: row.condition,
    location: row.location,
  };
}

async function toCards(rows: CardRow[], now: Date): Promise<ProductCardDto[]> {
  const promos = await promotionsFor(rows.map((r) => r.id), now);
  return rows.map((r) => toCard(r, promos.get(r.id) ?? []));
}

/** First `limit` products of a source (carousels, deal sections). */
export async function productsForSource(source: ProductSource, limit: number, now = new Date()): Promise<ProductCardDto[]> {
  return (await productPageForSource(source, 1, limit, now)).items;
}

/** One page of a source (grids). Pages are 1-based. */
export async function productPageForSource(source: ProductSource, page: number, pageSize: number, now = new Date()) {
  const plan = await planFor(source, now);
  if (!plan) return { items: [], page, pageSize, total: 0, hasMore: false };

  if (plan.manualOrder) {
    // Keep the admin's order; the id list is short (≤ 60).
    const rows = await prisma.product.findMany({ where: plan.where, select: cardSelect });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = plan.manualOrder.map((id) => byId.get(id)).filter((r): r is CardRow => !!r);
    const slice = ordered.slice((page - 1) * pageSize, page * pageSize);
    return { items: await toCards(slice, now), page, pageSize, total: ordered.length, hasMore: page * pageSize < ordered.length };
  }

  const [rows, total] = await Promise.all([
    prisma.product.findMany({ where: plan.where, orderBy: plan.orderBy, skip: (page - 1) * pageSize, take: pageSize, select: cardSelect }),
    prisma.product.count({ where: plan.where }),
  ]);
  return { items: await toCards(rows, now), page, pageSize, total, hasMore: page * pageSize < total };
}

/** Cards for specific ids, in the given order (recently viewed). Hidden products are skipped. */
export async function productsByIds(ids: string[], now = new Date()): Promise<ProductCardDto[]> {
  if (!ids.length) return [];
  const rows = await prisma.product.findMany({ where: { ...liveProductWhere(now), id: { in: ids } }, select: cardSelect });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return toCards(ids.map((id) => byId.get(id)).filter((r): r is CardRow => !!r), now);
}

/**
 * Earliest moment after `now` at which any catalog price or visibility changes
 * (a promotion starts or ends, a product is scheduled to publish or unpublish).
 * Pages cache until then.
 */
export async function nextCatalogChange(now: Date): Promise<Date | null> {
  const [promo, product] = await Promise.all([
    prisma.$queryRaw<Array<{ at: Date | null }>>`
      SELECT LEAST(
        (SELECT MIN("startsAt") FROM "Promotion" WHERE "isActive" AND "startsAt" > ${now}),
        (SELECT MIN("endsAt") FROM "Promotion" WHERE "isActive" AND "endsAt" > ${now})
      ) AS at`,
    prisma.$queryRaw<Array<{ at: Date | null }>>`
      SELECT LEAST(
        (SELECT MIN("publishAt") FROM "Product" WHERE "publishAt" > ${now}),
        (SELECT MIN("unpublishAt") FROM "Product" WHERE "unpublishAt" > ${now})
      ) AS at`,
  ]);
  const times = [promo[0]?.at, product[0]?.at].filter((d): d is Date => d instanceof Date);
  return times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
}
