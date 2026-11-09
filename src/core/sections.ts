import { z } from "zod";

/**
 * Page-builder section types. Each type's `config` JSON is validated by its schema.
 * To add a new section type:
 *   1. add a schema to SECTION_SCHEMAS (+ label/description in SECTION_META)
 *   2. add a renderer in frontend/components/sections
 *   3. add an editor form in frontend/components/admin/sections
 */

const id = z.string().min(1);

/** Where a product carousel / grid gets its products from. */
export const productSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), productIds: z.array(id).max(60).default([]) }),
  z.object({ kind: z.literal("category"), categoryId: z.string().min(1, "Choose a category."), includeChildren: z.boolean().default(true) }),
  z.object({ kind: z.literal("tag"), tagSlug: z.string().min(1, "Choose a tag.") }),
  z.object({ kind: z.literal("brand"), brandId: z.string().min(1, "Choose a brand.") }),
  z.object({ kind: z.literal("promotion"), promotionId: z.string().min(1, "Choose a promotion.") }),
  z.object({ kind: z.literal("best-sellers"), categoryId: id.optional() }),
  z.object({ kind: z.literal("newest"), categoryId: id.optional() }),
  z.object({ kind: z.literal("on-sale"), categoryId: id.optional() }),
  z.object({ kind: z.literal("top-rated"), categoryId: id.optional() }),
  /** Per-shopper; rendered client-side / per request. */
  z.object({ kind: z.literal("recently-viewed") }),
]);
export type ProductSource = z.infer<typeof productSourceSchema>;

export const heroConfigSchema = z.object({
  bannerIds: z.array(id).min(1, "Add at least one banner.").max(10, "Up to 10 banners."),
  autoplay: z.boolean().default(true),
  intervalMs: z.number().int().min(3000).max(15000).default(6000),
  height: z.enum(["md", "lg"]).default("md"),
});

export const categoryTilesConfigSchema = z.object({
  /** Empty = all categories with featuredOnHome = true. */
  categoryIds: z.array(id).max(24).default([]),
  style: z.enum(["circles", "tiles"]).default("circles"),
  max: z.number().int().min(2).max(24).default(10),
});

export const productCarouselConfigSchema = z.object({
  source: productSourceSchema,
  limit: z.number().int().min(4).max(30).default(12),
});

export const promoBannerConfigSchema = z
  .object({
    layout: z.enum(["single", "split", "three"]).default("single"),
    bannerIds: z.array(id).min(1, "Add a banner.").max(3),
  })
  .refine((c) => c.bannerIds.length === { single: 1, split: 2, three: 3 }[c.layout], {
    message: "Pick 1 banner for single, 2 for split, 3 for three-up",
    path: ["bannerIds"],
  });

export const dealCountdownConfigSchema = z.object({
  endsAt: z.iso.datetime({ offset: true, error: "Set when the deal ends." }),
  headline: z.string().max(80).default("Deal of the day"),
  body: z.string().max(240).default(""),
  source: productSourceSchema,
  limit: z.number().int().min(1).max(12).default(4),
  ctaLabel: z.string().max(30).default("Shop the deal"),
  ctaUrl: z.string().max(500).default("/deals"),
});

export const brandStripConfigSchema = z.object({
  /** Empty = featured brands. */
  brandIds: z.array(id).max(24).default([]),
  grayscale: z.boolean().default(true),
});

export const productGridConfigSchema = z.object({
  source: productSourceSchema,
  pageSize: z.number().int().min(8).max(48).default(24),
  pagination: z.enum(["infinite", "paged", "none"]).default("infinite"),
  /** Hard cap on items loaded by infinite scroll. */
  maxItems: z.number().int().min(8).max(500).default(120),
});

export const richTextConfigSchema = z.object({
  /** Sanitized HTML (sanitized again on render). */
  html: z.string().min(1, "Add some content.").max(50_000, "This content is too long."),
  width: z.enum(["content", "full"]).default("content"),
  align: z.enum(["left", "center"]).default("left"),
});

export const newsletterConfigSchema = z.object({
  headline: z.string().max(80).default("Get deals in your inbox"),
  body: z.string().max(240).default("Weekly picks and price drops. Unsubscribe anytime."),
  placeholder: z.string().max(60).default("Email address"),
  buttonLabel: z.string().max(30).default("Subscribe"),
  successMessage: z.string().max(120).default("You're in. Watch your inbox for the next deal."),
});

export const SECTION_SCHEMAS = {
  hero: heroConfigSchema,
  "category-tiles": categoryTilesConfigSchema,
  "product-carousel": productCarouselConfigSchema,
  "promo-banner": promoBannerConfigSchema,
  "deal-countdown": dealCountdownConfigSchema,
  "brand-strip": brandStripConfigSchema,
  "product-grid": productGridConfigSchema,
  "rich-text": richTextConfigSchema,
  newsletter: newsletterConfigSchema,
} as const;

export type SectionType = keyof typeof SECTION_SCHEMAS;
export const SECTION_TYPES = Object.keys(SECTION_SCHEMAS) as SectionType[];
export type SectionConfig<T extends SectionType> = z.infer<(typeof SECTION_SCHEMAS)[T]>;

export const SECTION_META: Record<SectionType, { label: string; description: string }> = {
  hero: { label: "Hero carousel", description: "Rotating full-width banners with headline and CTA." },
  "category-tiles": { label: "Shop by category", description: "Category circles or tiles with images." },
  "product-carousel": { label: "Product carousel", description: "A scrollable row of products from any source." },
  "promo-banner": { label: "Promo banner", description: "One, two or three linked image banners." },
  "deal-countdown": { label: "Deal countdown", description: "A timed deal with a live countdown." },
  "brand-strip": { label: "Brand strip", description: "Brand logos linking to brand pages." },
  "product-grid": { label: "Product grid", description: "A paginated or infinite grid of products." },
  "rich-text": { label: "Rich text", description: "Custom formatted content (sanitized HTML)." },
  newsletter: { label: "Newsletter signup", description: "Email capture form." },
};

/** Fields every section has (stored as columns, not in config). */
export const sectionBaseSchema = z.object({
  name: z.string().max(80).nullish(),
  title: z.string().max(120).nullish(),
  subtitle: z.string().max(240).nullish(),
  seeAllUrl: z.string().max(500).nullish(),
  isVisible: z.boolean().default(true),
  device: z.enum(["ALL", "DESKTOP", "MOBILE"]).default("ALL"),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  background: z
    .object({
      style: z.enum(["none", "subtle", "brand", "color", "image"]).default("none"),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      imageId: z.string().optional(),
    })
    .nullish(),
});

/** Full section payload: base fields + typed config, discriminated by `type`. */
const withType = <T extends SectionType>(type: T) =>
  sectionBaseSchema.extend({ type: z.literal(type), config: SECTION_SCHEMAS[type] });

export const sectionInputSchema = z.discriminatedUnion("type", [
  withType("hero"),
  withType("category-tiles"),
  withType("product-carousel"),
  withType("promo-banner"),
  withType("deal-countdown"),
  withType("brand-strip"),
  withType("product-grid"),
  withType("rich-text"),
  withType("newsletter"),
]);
export type SectionInput = z.infer<typeof sectionInputSchema>;

export function parseSectionConfig<T extends SectionType>(type: T, config: unknown): SectionConfig<T> {
  return SECTION_SCHEMAS[type].parse(config) as SectionConfig<T>;
}

export function safeParseSectionConfig(type: string, config: unknown) {
  if (!(type in SECTION_SCHEMAS)) {
    return { success: false as const, error: new Error(`Unknown section type "${type}"`) };
  }
  return SECTION_SCHEMAS[type as SectionType].safeParse(config);
}

export function isSectionType(type: string): type is SectionType {
  return type in SECTION_SCHEMAS;
}
