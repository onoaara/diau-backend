import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  contrastRatio,
  isSectionType,
  safeHref,
  SECTION_SCHEMAS,
  sectionBaseSchema,
  type SectionConfig,
  type SectionType,
} from "../core";
import {
  nextCatalogChange,
  productCardDto,
  productPageDto,
  productPageForSource,
  productsForSource,
} from "../catalog/product-feed";
import { prisma } from "../db";
import { HttpError, notFound } from "../lib/errors";
import { mediaDtoSchema, mediaSelect, toMediaDto } from "../lib/media";
import { sanitizeRichText } from "../lib/sanitize";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Response shapes ───────────────────────────────────────────────────────────

const bannerDto = z.object({
  id: z.string(),
  headline: z.string().nullable(),
  subtext: z.string().nullable(),
  ctaLabel: z.string().nullable(),
  href: z.string().nullable(),
  ctaStyle: z.enum(["accent", "brand", "light"]),
  layout: z.enum(["text-left", "text-right", "image-only"]),
  backgroundColor: z.string().nullable(),
  textTone: z.enum(["light", "dark"]),
  desktopImage: mediaDtoSchema,
  mobileImage: mediaDtoSchema.nullable(),
});
type BannerDto = z.infer<typeof bannerDto>;

const sectionCommon = {
  id: z.string(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  seeAllHref: z.string().nullable(),
  device: z.enum(["ALL", "DESKTOP", "MOBILE"]),
  background: z.object({
    style: z.enum(["none", "subtle", "brand", "color", "image"]),
    color: z.string().nullable(),
    /** Text tone that keeps contrast on the custom color / image. */
    tone: z.enum(["light", "dark"]),
    image: mediaDtoSchema.nullable(),
  }),
};

const sectionDto = z.discriminatedUnion("type", [
  z.object({
    ...sectionCommon,
    type: z.literal("hero"),
    config: z.object({ autoplay: z.boolean(), intervalMs: z.number(), height: z.enum(["md", "lg"]) }),
    data: z.object({ banners: z.array(bannerDto) }),
  }),
  z.object({
    ...sectionCommon,
    type: z.literal("category-tiles"),
    config: z.object({ style: z.enum(["circles", "tiles"]) }),
    data: z.object({
      categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), image: mediaDtoSchema.nullable() })),
    }),
  }),
  z.object({
    ...sectionCommon,
    type: z.literal("product-carousel"),
    config: z.object({ sourceKind: z.string(), limit: z.number() }),
    data: z.object({ products: z.array(productCardDto) }),
  }),
  z.object({
    ...sectionCommon,
    type: z.literal("promo-banner"),
    config: z.object({ layout: z.enum(["single", "split", "three"]) }),
    data: z.object({ banners: z.array(bannerDto) }),
  }),
  z.object({
    ...sectionCommon,
    type: z.literal("deal-countdown"),
    config: z.object({
      endsAt: z.string(),
      headline: z.string(),
      body: z.string(),
      ctaLabel: z.string(),
      ctaHref: z.string().nullable(),
    }),
    data: z.object({ products: z.array(productCardDto) }),
  }),
  z.object({
    ...sectionCommon,
    type: z.literal("brand-strip"),
    config: z.object({ grayscale: z.boolean() }),
    data: z.object({
      brands: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), logo: mediaDtoSchema.nullable() })),
    }),
  }),
  z.object({
    ...sectionCommon,
    type: z.literal("product-grid"),
    config: z.object({ pagination: z.enum(["infinite", "paged", "none"]), pageSize: z.number(), maxItems: z.number() }),
    data: z.object({ firstPage: productPageDto }),
  }),
  z.object({
    ...sectionCommon,
    type: z.literal("rich-text"),
    config: z.object({ width: z.enum(["content", "full"]), align: z.enum(["left", "center"]) }),
    data: z.object({ html: z.string() }),
  }),
  z.object({
    ...sectionCommon,
    type: z.literal("newsletter"),
    config: z.object({
      headline: z.string(),
      body: z.string(),
      placeholder: z.string(),
      buttonLabel: z.string(),
      successMessage: z.string(),
    }),
    data: z.object({}),
  }),
]);
type SectionDto = z.infer<typeof sectionDto>;

export const sectionDtoSchema = sectionDto;

const pageResponse = z.object({
  page: z.object({
    slug: z.string(),
    title: z.string(),
    kind: z.enum(["HOME", "LANDING", "CONTENT"]),
    seoTitle: z.string().nullable(),
    seoDescription: z.string().nullable(),
    /** Tiptap JSON body (content pages); rendered by the storefront's safe renderer. */
    content: z.unknown().nullable(),
    publishedAt: z.string().nullable(),
  }),
  sections: z.array(sectionDto),
  /** The page's content stays valid until this moment (next scheduled change). */
  validUntil: z.string(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const bannerSelect = {
  id: true,
  headline: true,
  subtext: true,
  ctaLabel: true,
  linkUrl: true,
  ctaStyle: true,
  layout: true,
  backgroundColor: true,
  textTone: true,
  startsAt: true,
  endsAt: true,
  isActive: true,
  desktopImage: { select: mediaSelect },
  mobileImage: { select: mediaSelect },
} as const;

const oneOf = <T extends string>(value: string, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Collects the earliest future boundary seen while building a page. */
class Boundaries {
  private next: number;
  constructor(private readonly now: Date) {
    this.next = now.getTime() + DAY_MS;
  }
  add(...dates: Array<Date | null | undefined>) {
    for (const d of dates) {
      if (d && d.getTime() > this.now.getTime()) this.next = Math.min(this.next, d.getTime());
    }
  }
  get value() {
    return new Date(this.next);
  }
}

/** Banners in the configured order, only those active and in their schedule. */
async function loadBanners(ids: string[], now: Date, boundaries: Boundaries): Promise<BannerDto[]> {
  const rows = await prisma.banner.findMany({ where: { id: { in: ids } }, select: bannerSelect });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: BannerDto[] = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (!b || !b.isActive) continue;
    boundaries.add(b.startsAt, b.endsAt);
    if ((b.startsAt && b.startsAt > now) || (b.endsAt && b.endsAt <= now)) continue;
    out.push({
      id: b.id,
      headline: b.headline,
      subtext: b.subtext,
      ctaLabel: b.ctaLabel,
      href: safeHref(b.linkUrl),
      ctaStyle: oneOf(b.ctaStyle, ["accent", "brand", "light"] as const, "brand"),
      layout: oneOf(b.layout, ["text-left", "text-right", "image-only"] as const, "text-left"),
      backgroundColor: /^#[0-9a-fA-F]{6}$/.test(b.backgroundColor ?? "") ? b.backgroundColor : null,
      textTone: b.textTone === "light" ? "light" : "dark",
      desktopImage: toMediaDto(b.desktopImage)!,
      mobileImage: toMediaDto(b.mobileImage),
    });
  }
  return out;
}

/** Light text on dark colors, dark text on light ones (whichever contrasts more). */
function toneFor(hex: string): "light" | "dark" {
  return contrastRatio("#ffffff", hex) >= contrastRatio("#141821", hex) ? "light" : "dark";
}

async function backgroundOf(raw: unknown): Promise<SectionDto["background"]> {
  const parsed = sectionBaseSchema.shape.background.safeParse(raw);
  const bg = parsed.success ? parsed.data : null;
  if (!bg || bg.style === "none") return { style: "none", color: null, tone: "dark", image: null };
  if (bg.style === "color" && bg.color) return { style: "color", color: bg.color, tone: toneFor(bg.color), image: null };
  if (bg.style === "image" && bg.imageId) {
    const media = await prisma.mediaAsset.findUnique({ where: { id: bg.imageId }, select: mediaSelect });
    // Image backgrounds always get a dark scrim, so text is light.
    if (media) return { style: "image", color: null, tone: "light", image: toMediaDto(media) };
  }
  if (bg.style === "brand") return { style: "brand", color: null, tone: "light", image: null };
  return { style: "subtle", color: null, tone: "dark", image: null };
}

type SectionRow = {
  id: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  seeAllUrl: string | null;
  config: unknown;
  background: unknown;
  device: "ALL" | "DESKTOP" | "MOBILE";
};

/** Resolves one section's data. Returns null when it has nothing to show. */
async function buildSection(row: SectionRow, now: Date, boundaries: Boundaries, log: (msg: string) => void): Promise<SectionDto | null> {
  if (!isSectionType(row.type)) {
    log(`skipping section ${row.id}: unknown type "${row.type}"`);
    return null;
  }
  const parsed = SECTION_SCHEMAS[row.type].safeParse(row.config);
  if (!parsed.success) {
    log(`skipping section ${row.id} (${row.type}): invalid config`);
    return null;
  }
  const common = {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    seeAllHref: safeHref(row.seeAllUrl),
    device: row.device,
    background: await backgroundOf(row.background),
  };
  const type: SectionType = row.type;
  const config = parsed.data;

  switch (type) {
    case "hero": {
      const c = config as SectionConfig<"hero">;
      const banners = await loadBanners(c.bannerIds, now, boundaries);
      if (!banners.length) return null;
      return { ...common, type, config: { autoplay: c.autoplay, intervalMs: c.intervalMs, height: c.height }, data: { banners } };
    }
    case "promo-banner": {
      const c = config as SectionConfig<"promo-banner">;
      const banners = await loadBanners(c.bannerIds, now, boundaries);
      if (!banners.length) return null;
      // If a scheduled banner is off, fall back to the layout that fits what's left.
      const layout = (["single", "split", "three"] as const)[banners.length - 1] ?? "single";
      return { ...common, type, config: { layout }, data: { banners } };
    }
    case "category-tiles": {
      const c = config as SectionConfig<"category-tiles">;
      const select = { id: true, name: true, slug: true, image: { select: mediaSelect } } as const;
      let rows;
      if (c.categoryIds.length) {
        const found = await prisma.category.findMany({ where: { id: { in: c.categoryIds }, isVisible: true }, select });
        const byId = new Map(found.map((r) => [r.id, r]));
        rows = c.categoryIds.map((id) => byId.get(id)).filter((r) => r !== undefined);
      } else {
        rows = await prisma.category.findMany({
          where: { featuredOnHome: true, isVisible: true },
          orderBy: [{ parentId: { sort: "asc", nulls: "first" } }, { position: "asc" }],
          select,
        });
      }
      const categories = rows.slice(0, c.max).map((r) => ({ id: r.id, name: r.name, slug: r.slug, image: toMediaDto(r.image) }));
      if (!categories.length) return null;
      return { ...common, type, config: { style: c.style }, data: { categories } };
    }
    case "product-carousel": {
      const c = config as SectionConfig<"product-carousel">;
      const products = await productsForSource(c.source, c.limit, now);
      // Recently viewed is filled in by the shopper's browser; everything else hides when empty.
      if (!products.length && c.source.kind !== "recently-viewed") return null;
      return { ...common, type, config: { sourceKind: c.source.kind, limit: c.limit }, data: { products } };
    }
    case "deal-countdown": {
      const c = config as SectionConfig<"deal-countdown">;
      const endsAt = new Date(c.endsAt);
      if (endsAt <= now) return null;
      boundaries.add(endsAt);
      const products = await productsForSource(c.source, c.limit, now);
      return {
        ...common,
        type,
        config: { endsAt: endsAt.toISOString(), headline: c.headline, body: c.body, ctaLabel: c.ctaLabel, ctaHref: safeHref(c.ctaUrl) },
        data: { products },
      };
    }
    case "brand-strip": {
      const c = config as SectionConfig<"brand-strip">;
      const select = { id: true, name: true, slug: true, logo: { select: mediaSelect } } as const;
      let rows;
      if (c.brandIds.length) {
        const found = await prisma.brand.findMany({ where: { id: { in: c.brandIds } }, select });
        const byId = new Map(found.map((r) => [r.id, r]));
        rows = c.brandIds.map((id) => byId.get(id)).filter((r) => r !== undefined);
      } else {
        rows = await prisma.brand.findMany({ where: { isFeatured: true }, orderBy: { name: "asc" }, select });
      }
      if (!rows.length) return null;
      return {
        ...common,
        type,
        config: { grayscale: c.grayscale },
        data: { brands: rows.map((b) => ({ id: b.id, name: b.name, slug: b.slug, logo: toMediaDto(b.logo) })) },
      };
    }
    case "product-grid": {
      const c = config as SectionConfig<"product-grid">;
      const firstPage = await productPageForSource(c.source, 1, Math.min(c.pageSize, c.maxItems), now);
      if (!firstPage.items.length) return null;
      return {
        ...common,
        type,
        config: { pagination: c.pagination, pageSize: c.pageSize, maxItems: c.maxItems },
        data: { firstPage: { ...firstPage, total: Math.min(firstPage.total, c.maxItems), hasMore: c.pagination !== "none" && firstPage.hasMore && c.pageSize < c.maxItems } },
      };
    }
    case "rich-text": {
      const c = config as SectionConfig<"rich-text">;
      const html = sanitizeRichText(c.html);
      if (!html.trim()) return null;
      return { ...common, type, config: { width: c.width, align: c.align }, data: { html } };
    }
    case "newsletter": {
      const c = config as SectionConfig<"newsletter">;
      return { ...common, type, config: c, data: {} };
    }
  }
}

export type RenderableSection = SectionRow & { startsAt: Date | null; endsAt: Date | null };

/** Why a section isn't on the page (shown in the admin preview). */
export type SkippedSection = { id: string; reason: "hidden" | "scheduled" | "empty" | "invalid" };

/**
 * Resolves an ordered section list at `now`: schedule filter, then each section's data.
 * Shared by the storefront (published sections) and the admin preview (draft sections).
 */
export async function renderSections(rows: Array<RenderableSection & { isVisible?: boolean }>, now: Date, log: (msg: string) => void) {
  const boundaries = new Boundaries(now);
  const skipped: SkippedSection[] = [];
  const live = rows.filter((s) => {
    boundaries.add(s.startsAt, s.endsAt);
    if (s.isVisible === false) {
      skipped.push({ id: s.id, reason: "hidden" });
      return false;
    }
    const inWindow = (!s.startsAt || s.startsAt <= now) && (!s.endsAt || s.endsAt > now);
    if (!inWindow) skipped.push({ id: s.id, reason: "scheduled" });
    return inWindow;
  });
  const [built, catalogChange] = await Promise.all([Promise.all(live.map((s) => buildSection(s, now, boundaries, log))), nextCatalogChange(now)]);
  boundaries.add(catalogChange);
  built.forEach((b, i) => {
    if (b) return;
    const row = live[i]!;
    const valid = isSectionType(row.type) && SECTION_SCHEMAS[row.type].safeParse(row.config).success;
    skipped.push({ id: row.id, reason: valid ? "empty" : "invalid" });
  });
  return { sections: built.filter((s): s is SectionDto => s !== null), skipped, validUntil: boundaries.value };
}

export async function renderPage(slug: string, log: (msg: string) => void) {
  const now = new Date();
  const page = await prisma.page.findFirst({
    where: { slug, status: "PUBLISHED" },
    select: {
      slug: true,
      title: true,
      kind: true,
      seoTitle: true,
      seoDescription: true,
      content: true,
      publishedAt: true,
      sections: {
        where: { isVisible: true },
        orderBy: { position: "asc" },
        select: {
          id: true,
          type: true,
          title: true,
          subtitle: true,
          seeAllUrl: true,
          config: true,
          background: true,
          device: true,
          startsAt: true,
          endsAt: true,
        },
      },
    },
  });
  if (!page) return null;

  const { sections: rows, publishedAt, content, ...meta } = page;
  const { sections, validUntil } = await renderSections(rows, now, log);
  return { page: { ...meta, content: content ?? null, publishedAt: publishedAt?.toISOString() ?? null }, sections, validUntil: validUntil.toISOString() };
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const pageRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/pages/:slug",
    {
      schema: {
        tags: ["storefront"],
        params: z.object({ slug: z.string().regex(/^[a-z0-9-]{1,100}$/) }),
        response: { 200: pageResponse },
      },
    },
    async (req) => {
      const result = await renderPage(req.params.slug, (msg) => req.log.warn(msg));
      if (!result) throw notFound("Page");
      return result;
    },
  );

  /** Further pages of a product grid / carousel section ("Load more", pagination). */
  app.get(
    "/sections/:id/products",
    {
      schema: {
        tags: ["storefront"],
        params: z.object({ id: z.string().min(1).max(40) }),
        querystring: z.object({ page: z.coerce.number().int().min(1).max(100).default(1) }),
        response: { 200: productPageDto },
      },
    },
    async (req) => {
      const now = new Date();
      const section = await prisma.section.findFirst({
        where: {
          id: req.params.id,
          isVisible: true,
          type: { in: ["product-grid", "product-carousel"] },
          page: { status: "PUBLISHED" },
          AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
        },
        select: { type: true, config: true },
      });
      if (!section) throw notFound("Section");

      if (section.type === "product-grid") {
        const parsed = SECTION_SCHEMAS["product-grid"].safeParse(section.config);
        if (!parsed.success) throw notFound("Section");
        const { source, pageSize, maxItems, pagination } = parsed.data;
        if (pagination === "none" && req.query.page > 1) throw new HttpError(404, "not_found", "No more products.");
        const result = await productPageForSource(source, req.query.page, pageSize, now);
        // Enforce the section's item cap.
        const shown = (req.query.page - 1) * pageSize;
        const remaining = Math.max(0, maxItems - shown);
        const items = result.items.slice(0, remaining);
        return { ...result, items, total: Math.min(result.total, maxItems), hasMore: result.hasMore && shown + items.length < maxItems };
      }
      const parsed = SECTION_SCHEMAS["product-carousel"].safeParse(section.config);
      if (!parsed.success) throw notFound("Section");
      return productPageForSource(parsed.data.source, req.query.page, parsed.data.limit, now);
    },
  );
};
