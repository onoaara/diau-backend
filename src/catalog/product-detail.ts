import { z } from "zod";
import { effectivePrice, safeHref, type PromotionDiscount } from "../core";
import { prisma } from "../db";
import { mediaDtoSchema } from "../lib/media";
import { readSite } from "../routes/settings";
import { liveProductWhere, productCardDto, productsByIds } from "./product-feed";

/**
 * Everything the product page needs, in one call (DESIGN.md §6.3). Prices are
 * promotion-aware per variant, using the same `effectivePrice` as cards and checkout.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const REVIEWS_PAGE_SIZE = 10;

export const reviewDto = z.object({
  id: z.string(),
  authorName: z.string(),
  rating: z.number().int(),
  title: z.string().nullable(),
  body: z.string(),
  isVerified: z.boolean(),
  createdAt: z.string(),
  images: z.array(mediaDtoSchema),
});
export const reviewPageDto = z.object({
  items: z.array(reviewDto),
  total: z.number().int(),
  page: z.number().int(),
  pageCount: z.number().int(),
});

const priceDto = { priceCents: z.number().int(), compareAtPriceCents: z.number().int().nullable() };

export const productDetailDto = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  sku: z.string().nullable(),
  condition: z.enum(["NEW", "USED", "REFURBISHED"]),
  brand: z.object({ name: z.string(), slug: z.string() }).nullable(),
  categoryTrail: z.array(z.object({ name: z.string(), slug: z.string() })),
  /** Tiptap JSON document (rendered by the storefront's safe renderer). */
  description: z.unknown().nullable(),
  descriptionText: z.string(),
  images: z.array(mediaDtoSchema),
  video: z.object({ url: z.string() }).nullable(),
  ...priceDto,
  promotionEndsAt: z.string().nullable(),
  freeShipping: z.boolean(),
  location: z.string().nullable(),
  ratingAvg: z.number(),
  ratingCount: z.number().int(),
  soldCount: z.number().int(),
  options: z.array(z.object({ name: z.string(), values: z.array(z.object({ value: z.string(), swatchHex: z.string().nullable() })) })),
  variants: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      options: z.record(z.string(), z.string()),
      ...priceDto,
      stock: z.number().int(),
      sku: z.string().nullable(),
      imageId: z.string().nullable(),
    }),
  ),
  /** Stock for products without variants. */
  stock: z.number().int(),
  trackInventory: z.boolean(),
  lowStockThreshold: z.number().int(),
  specs: z.array(z.object({ label: z.string(), value: z.string() })),
  policies: z.object({ shipping: z.string(), returns: z.string(), payments: z.string() }),
  delivery: z
    .object({ region: z.string(), method: z.string(), minDays: z.number().int(), maxDays: z.number().int(), priceCents: z.number().int(), freeOverCents: z.number().int().nullable() })
    .nullable(),
  reviews: z.object({
    breakdown: z.object({ 1: z.number().int(), 2: z.number().int(), 3: z.number().int(), 4: z.number().int(), 5: z.number().int() }),
    firstPage: reviewPageDto,
  }),
  similar: z.array(productCardDto),
  moreFromBrand: z.array(productCardDto),
  seo: z.object({ title: z.string(), description: z.string() }),
  /** Valid until the next promotion change for this product. */
  validUntil: z.string(),
});
export type ProductDetail = z.infer<typeof productDetailDto>;

type OptionValue = { value: string; swatchHex: string | null };

function parseOptionValues(raw: unknown): OptionValue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v): OptionValue[] => {
    if (typeof v === "string") return [{ value: v, swatchHex: null }];
    if (v && typeof v === "object" && typeof (v as { value?: unknown }).value === "string") {
      const hex = (v as { swatchHex?: unknown }).swatchHex;
      return [{ value: (v as { value: string }).value, swatchHex: typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex) ? hex : null }];
    }
    return [];
  });
}

function parseVariantOptions(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
}

const CONDITION_LABEL = { NEW: "New", USED: "Used", REFURBISHED: "Refurbished" } as const;

export async function reviewPage(productId: string, opts: { page: number; rating: number | null; sort: "newest" | "highest" | "lowest" }) {
  const where = { productId, status: "APPROVED" as const, ...(opts.rating ? { rating: opts.rating } : {}) };
  const orderBy =
    opts.sort === "highest"
      ? [{ rating: "desc" as const }, { createdAt: "desc" as const }]
      : opts.sort === "lowest"
        ? [{ rating: "asc" as const }, { createdAt: "desc" as const }]
        : [{ createdAt: "desc" as const }];
  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy,
      skip: (opts.page - 1) * REVIEWS_PAGE_SIZE,
      take: REVIEWS_PAGE_SIZE,
      select: {
        id: true,
        authorName: true,
        rating: true,
        title: true,
        body: true,
        isVerified: true,
        createdAt: true,
        images: { orderBy: { position: "asc" }, select: { media: { select: { id: true, url: true, alt: true, width: true, height: true } } } },
      },
    }),
    prisma.review.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), images: r.images.map((i) => i.media) })),
    total,
    page: opts.page,
    pageCount: Math.max(1, Math.ceil(total / REVIEWS_PAGE_SIZE)),
  };
}

/** Similar items: same category, then the parent category if that's thin. */
async function relatedProducts(product: { id: string; categoryId: string; brandId: string | null }, parentId: string | null, now: Date) {
  const live = liveProductWhere(now);
  const pick = (where: object, take: number) =>
    prisma.product.findMany({ where: { ...live, ...where, id: { not: product.id } }, orderBy: [{ soldCount: "desc" }, { id: "asc" }], take, select: { id: true } });
  let similarIds = (await pick({ categoryId: product.categoryId }, 12)).map((p) => p.id);
  if (similarIds.length < 6 && parentId) {
    const siblings = await prisma.category.findMany({ where: { parentId, isVisible: true }, select: { id: true } });
    const more = await pick({ categoryId: { in: siblings.map((s) => s.id) }, id: { notIn: [product.id, ...similarIds] } }, 12 - similarIds.length);
    similarIds = [...similarIds, ...more.map((p) => p.id)];
  }
  const brandIds = product.brandId
    ? (await pick({ brandId: product.brandId, id: { notIn: [product.id, ...similarIds] } }, 12)).map((p) => p.id)
    : [];
  const [similar, moreFromBrand] = await Promise.all([productsByIds(similarIds, now), productsByIds(brandIds, now)]);
  return { similar, moreFromBrand };
}

export async function readProductDetail(slug: string): Promise<ProductDetail | null> {
  const now = new Date();
  const p = await prisma.product.findFirst({
    where: { ...liveProductWhere(now), slug },
    select: {
      id: true,
      slug: true,
      title: true,
      sku: true,
      condition: true,
      description: true,
      descriptionText: true,
      priceCents: true,
      compareAtPriceCents: true,
      stock: true,
      trackInventory: true,
      lowStockThreshold: true,
      freeShipping: true,
      location: true,
      ratingAvg: true,
      ratingCount: true,
      soldCount: true,
      seoTitle: true,
      seoDescription: true,
      videoUrl: true,
      shippingInfo: true,
      returnsInfo: true,
      weightGrams: true,
      categoryId: true,
      brandId: true,
      brand: { select: { name: true, slug: true } },
      category: { select: { id: true, parentId: true, isVisible: true } },
      images: { orderBy: { position: "asc" }, select: { alt: true, media: { select: { id: true, url: true, alt: true, width: true, height: true } } } },
      options: { orderBy: { position: "asc" }, select: { name: true, values: true } },
      variants: { where: { isActive: true }, orderBy: { position: "asc" }, select: { id: true, title: true, options: true, priceCents: true, compareAtPriceCents: true, stock: true, sku: true, imageId: true } },
      attributes: {
        where: { attribute: { showInSpecs: true } },
        select: {
          textValue: true,
          numberValue: true,
          booleanValue: true,
          value: { select: { value: true } },
          attribute: { select: { name: true, unit: true, position: true } },
        },
      },
      promotions: {
        where: { promotion: { isActive: true, endsAt: { gt: now } } },
        select: { specialPriceCents: true, promotion: { select: { id: true, discountType: true, value: true, startsAt: true, endsAt: true } } },
      },
    },
  });
  if (!p || !p.category.isVisible) return null;

  // Promotions: active ones set prices; upcoming ones bound the cache.
  const active: PromotionDiscount[] = p.promotions
    .filter((x) => x.promotion.startsAt <= now)
    .map((x) => ({ promotionId: x.promotion.id, discountType: x.promotion.discountType, value: x.promotion.value, specialPriceCents: x.specialPriceCents, endsAt: x.promotion.endsAt }));
  const boundaries = p.promotions.flatMap((x) => [x.promotion.startsAt, x.promotion.endsAt]).filter((d) => d > now);
  const validUntil = new Date(Math.min(now.getTime() + DAY_MS, ...boundaries.map((d) => d.getTime())));

  const base = effectivePrice(p, active);
  const variants = p.variants.map((v) => {
    const vp = effectivePrice({ priceCents: v.priceCents ?? p.priceCents, compareAtPriceCents: v.compareAtPriceCents ?? p.compareAtPriceCents }, active);
    return { id: v.id, title: v.title, options: parseVariantOptions(v.options), priceCents: vp.priceCents, compareAtPriceCents: vp.compareAtPriceCents, stock: v.stock, sku: v.sku, imageId: v.imageId };
  });

  // Category trail (top → product's category).
  const cats = await prisma.category.findMany({ where: { isVisible: true }, select: { id: true, name: true, slug: true, parentId: true } });
  const byId = new Map(cats.map((c) => [c.id, c]));
  const trail: Array<{ name: string; slug: string }> = [];
  for (let cur = byId.get(p.categoryId), guard = 0; cur && guard < 10; cur = cur.parentId ? byId.get(cur.parentId) : undefined, guard++) {
    trail.unshift({ name: cur.name, slug: cur.slug });
  }

  // Specifications: product facts first, then admin attributes (multi-select values joined).
  const specMap = new Map<string, { position: number; values: string[] }>();
  for (const a of p.attributes) {
    const value =
      a.value?.value ??
      a.textValue ??
      (a.numberValue !== null ? `${Number(a.numberValue.toFixed(2))}${a.attribute.unit ? ` ${a.attribute.unit}` : ""}` : null) ??
      (a.booleanValue !== null ? (a.booleanValue ? "Yes" : "No") : null);
    if (!value) continue;
    const entry = specMap.get(a.attribute.name) ?? { position: a.attribute.position, values: [] };
    if (!entry.values.includes(value)) entry.values.push(value);
    specMap.set(a.attribute.name, entry);
  }
  const specs = [
    ...(p.brand ? [{ label: "Brand", value: p.brand.name }] : []),
    { label: "Condition", value: CONDITION_LABEL[p.condition] },
    ...(p.sku ? [{ label: "SKU", value: p.sku }] : []),
    ...[...specMap.entries()].sort((a, b) => a[1].position - b[1].position).map(([label, e]) => ({ label, value: e.values.join(", ") })),
  ];

  // Delivery estimate from the first shipping zone (the store's home market) and its cheapest active rate.
  const zone = await prisma.shippingZone.findFirst({
    orderBy: { position: "asc" },
    select: { name: true, rates: { where: { isActive: true }, orderBy: [{ priceCents: "asc" }, { position: "asc" }], take: 1, select: { name: true, priceCents: true, freeOverCents: true, etaMinDays: true, etaMaxDays: true } } },
  });
  const rate = zone?.rates[0];

  const [site, breakdownRows, firstPage, related] = await Promise.all([
    readSite(),
    prisma.review.groupBy({ by: ["rating"], where: { productId: p.id, status: "APPROVED" }, _count: true }),
    reviewPage(p.id, { page: 1, rating: null, sort: "newest" }),
    relatedProducts(p, p.category.parentId, now),
  ]);
  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of breakdownRows) if (r.rating >= 1 && r.rating <= 5) breakdown[r.rating as 1 | 2 | 3 | 4 | 5] = r._count;

  const video = safeHref(p.videoUrl);

  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    sku: p.sku,
    condition: p.condition,
    brand: p.brand,
    categoryTrail: trail,
    description: p.description ?? null,
    descriptionText: p.descriptionText,
    images: p.images.map((i) => ({ ...i.media, alt: i.alt ?? i.media.alt })),
    video: video && /^https?:/i.test(video) ? { url: video } : null,
    priceCents: base.priceCents,
    compareAtPriceCents: base.compareAtPriceCents,
    promotionEndsAt: base.promotion?.endsAt.toISOString() ?? null,
    freeShipping: p.freeShipping || base.freeShippingPromo,
    location: p.location,
    ratingAvg: Math.round(p.ratingAvg * 10) / 10,
    ratingCount: p.ratingCount,
    soldCount: p.soldCount,
    options: p.options.map((o) => ({ name: o.name, values: parseOptionValues(o.values) })),
    variants,
    stock: p.stock,
    trackInventory: p.trackInventory,
    lowStockThreshold: p.lowStockThreshold,
    specs,
    policies: {
      shipping: p.shippingInfo ?? site.policies.shipping,
      returns: p.returnsInfo ?? site.policies.returns,
      payments: site.policies.payments,
    },
    delivery: zone && rate ? { region: zone.name, method: rate.name, minDays: rate.etaMinDays, maxDays: rate.etaMaxDays, priceCents: rate.priceCents, freeOverCents: rate.freeOverCents } : null,
    reviews: { breakdown, firstPage },
    similar: related.similar,
    moreFromBrand: related.moreFromBrand,
    seo: {
      title: p.seoTitle ?? p.title,
      description: (p.seoDescription ?? p.descriptionText).slice(0, 300),
    },
    validUntil: validUntil.toISOString(),
  };
}

/** Product ids → slugs for static generation. */
export async function liveProductSlugs(limit = 5000) {
  const rows = await prisma.product.findMany({ where: liveProductWhere(new Date()), select: { slug: true }, orderBy: { soldCount: "desc" }, take: limit });
  return rows.map((r) => r.slug);
}

