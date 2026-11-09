import { z } from "zod";
import { safeHref } from "./href";
import { MENU_ICONS } from "./navigation";

/**
 * Admin input schemas for the catalog (products, categories, attributes, brands).
 * The API validates every write with these; the admin UI maps `fields` errors
 * (keyed by path, e.g. "variants.2.priceCents") back onto inputs.
 */

const id = z.string().regex(/^[a-z0-9]{10,40}$/i, "Invalid id");
const slug = z
  .string()
  .trim()
  .min(1, "Enter a URL slug.")
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single dashes.");
const cents = (label: string) => z.number({ error: `Enter ${label}.` }).int().min(0, `${label} can't be negative.`).max(100_000_000, `${label} is too large.`);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #1A2B3C.");

// ── Rich text ────────────────────────────────────────────────────────────────

type TiptapNode = { type?: unknown; text?: unknown; content?: unknown };

/** Plain text of a Tiptap document (search index, meta descriptions). */
export function tiptapText(doc: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 50) return;
    const n = node as TiptapNode;
    if (n.type === "text" && typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child, depth + 1);
      if (["paragraph", "heading", "listItem", "blockquote"].includes(String(n.type))) parts.push("\n");
    }
  };
  walk(doc, 0);
  return parts.join("").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

export const tiptapDocSchema = z
  .unknown()
  .refine((v) => v === null || (typeof v === "object" && v !== null && (v as TiptapNode).type === "doc"), "Invalid description.")
  .refine((v) => JSON.stringify(v ?? null).length <= 100_000, "The description is too long.");

// ── Products ─────────────────────────────────────────────────────────────────

export const productOptionSchema = z.object({
  name: z.string().trim().min(1, "Name the option, e.g. Size.").max(40),
  values: z
    .array(z.object({ value: z.string().trim().min(1).max(40), swatchHex: hex.nullable().optional().transform((v) => v ?? null) }))
    .min(1, "Add at least one value.")
    .max(30),
});

export const productVariantSchema = z.object({
  id: id.optional(),
  options: z.record(z.string(), z.string()),
  priceCents: cents("a price").nullable(),
  compareAtPriceCents: cents("a compare-at price").nullable(),
  stock: z.number().int().min(0, "Stock can't be negative.").max(1_000_000),
  sku: optionalText(64),
  imageId: id.nullable().optional().transform((v) => v ?? null),
  isActive: z.boolean().default(true),
});

export const productAttributeInputSchema = z.object({
  attributeId: id,
  valueIds: z.array(id).max(50).optional(),
  textValue: optionalText(500),
  numberValue: z.number().finite().nullable().optional(),
  booleanValue: z.boolean().nullable().optional(),
});

export const productInputSchema = z
  .object({
    title: z.string().trim().min(3, "Enter a title (at least 3 characters).").max(200),
    slug: slug.optional(),
    status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]),
    condition: z.enum(["NEW", "USED", "REFURBISHED"]),
    categoryId: id,
    brandId: id.nullable(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    description: tiptapDocSchema.nullable(),
    priceCents: cents("a price"),
    compareAtPriceCents: cents("a compare-at price").nullable(),
    sku: optionalText(64),
    stock: z.number().int().min(0, "Stock can't be negative.").max(1_000_000),
    trackInventory: z.boolean(),
    lowStockThreshold: z.number().int().min(0).max(10_000),
    freeShipping: z.boolean(),
    location: optionalText(100),
    weightGrams: z.number().int().min(0).max(1_000_000).nullable(),
    shippingInfo: optionalText(1000),
    returnsInfo: optionalText(1000),
    seoTitle: optionalText(70),
    seoDescription: optionalText(160),
    videoUrl: z
      .string()
      .trim()
      .max(500)
      .nullable()
      .optional()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || (/^https:\/\//i.test(v) && safeHref(v) !== null), "Use an https:// video link."),
    publishAt: z.coerce.date().nullable(),
    unpublishAt: z.coerce.date().nullable(),
    images: z.array(z.object({ mediaId: id, alt: optionalText(200) })).max(15, "Up to 15 images."),
    options: z.array(productOptionSchema).max(3, "Up to 3 options (e.g. Size, Color, Material)."),
    variants: z.array(productVariantSchema).max(200),
    attributes: z.array(productAttributeInputSchema).max(60),
  })
  .superRefine((p, ctx) => {
    if (p.compareAtPriceCents !== null && p.compareAtPriceCents <= p.priceCents) {
      ctx.addIssue({ code: "custom", path: ["compareAtPriceCents"], message: "Compare-at price must be higher than the price (or leave it empty)." });
    }
    if (p.publishAt && p.unpublishAt && p.unpublishAt <= p.publishAt) {
      ctx.addIssue({ code: "custom", path: ["unpublishAt"], message: "End date must be after the start date." });
    }
    const names = p.options.map((o) => o.name.toLowerCase());
    names.forEach((n, i) => names.indexOf(n) !== i && ctx.addIssue({ code: "custom", path: ["options", i, "name"], message: "Option names must be unique." }));
    p.options.forEach((o, i) => {
      const vals = o.values.map((v) => v.value.toLowerCase());
      vals.forEach((v, j) => vals.indexOf(v) !== j && ctx.addIssue({ code: "custom", path: ["options", i, "values", j, "value"], message: "Values must be unique." }));
    });
    if (p.options.length && !p.variants.length) {
      ctx.addIssue({ code: "custom", path: ["variants"], message: "Generate variants for your options, or remove the options." });
    }
    const seen = new Set<string>();
    p.variants.forEach((v, i) => {
      const keys = Object.keys(v.options);
      const valid =
        keys.length === p.options.length &&
        p.options.every((o) => o.values.some((val) => val.value === v.options[o.name]));
      if (!valid) ctx.addIssue({ code: "custom", path: ["variants", i, "options"], message: "This variant doesn't match the options." });
      const combo = p.options.map((o) => v.options[o.name]).join(" / ");
      if (seen.has(combo)) ctx.addIssue({ code: "custom", path: ["variants", i, "options"], message: `Duplicate variant ${combo}.` });
      seen.add(combo);
      const price = v.priceCents ?? p.priceCents;
      if (v.compareAtPriceCents !== null && v.compareAtPriceCents <= price) {
        ctx.addIssue({ code: "custom", path: ["variants", i, "compareAtPriceCents"], message: "Must be higher than the variant price." });
      }
    });
    if (!p.options.length && p.variants.length) {
      ctx.addIssue({ code: "custom", path: ["variants"], message: "Variants need options." });
    }
  });
export type ProductInput = z.infer<typeof productInputSchema>;

/** Every combination of option values (for "Generate variants"). */
export function variantCombinations(options: Array<{ name: string; values: Array<{ value: string }> }>): Array<Record<string, string>> {
  return options.reduce<Array<Record<string, string>>>(
    (combos, opt) => combos.flatMap((c) => opt.values.map((v) => ({ ...c, [opt.name]: v.value }))),
    options.length ? [{}] : [],
  );
}

// ── Categories ───────────────────────────────────────────────────────────────

export const categoryInputSchema = z.object({
  name: z.string().trim().min(2, "Enter a name.").max(80),
  slug: slug.optional(),
  parentId: id.nullable(),
  description: optionalText(500),
  icon: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v === null || (MENU_ICONS as readonly string[]).includes(v), "Pick an icon from the list."),
  imageId: id.nullable(),
  bannerId: id.nullable(),
  seoTitle: optionalText(70),
  seoDescription: optionalText(160),
  isVisible: z.boolean(),
  showInMenu: z.boolean(),
  featuredOnHome: z.boolean(),
});

export const categoryReorderSchema = z.object({
  items: z.array(z.object({ id, parentId: id.nullable(), position: z.number().int().min(0) })).min(1).max(2000),
});

/** True when moving would put a category inside its own subtree. */
export function createsCycle(items: Array<{ id: string; parentId: string | null }>): boolean {
  const parent = new Map(items.map((i) => [i.id, i.parentId]));
  for (const start of parent.keys()) {
    const seen = new Set<string>();
    for (let cur: string | null | undefined = start; cur; cur = parent.get(cur)) {
      if (seen.has(cur)) return true;
      seen.add(cur);
    }
  }
  return false;
}

export const BUILT_IN_FILTERS = ["PRICE", "BRAND", "CONDITION", "RATING", "SHIPPING", "LOCATION"] as const;

export const categoryFilterSchema = z
  .object({
    builtIn: z.enum(BUILT_IN_FILTERS).nullable(),
    attributeId: id.nullable(),
    label: optionalText(40),
    displayType: z.enum(["CHECKBOX", "SLIDER", "SWATCH", "DROPDOWN", "TOGGLE"]),
    isCollapsed: z.boolean(),
    inheritToChildren: z.boolean(),
  })
  .refine((f) => (f.builtIn === null) !== (f.attributeId === null), "Pick either a built-in filter or an attribute.");

export const categoryFiltersInputSchema = z
  .object({ filters: z.array(categoryFilterSchema).max(30) })
  .superRefine((v, ctx) => {
    const keys = v.filters.map((f) => f.builtIn ?? f.attributeId);
    keys.forEach((k, i) => keys.indexOf(k) !== i && ctx.addIssue({ code: "custom", path: ["filters", i], message: "This filter is already in the list." }));
  });

// ── Attributes ───────────────────────────────────────────────────────────────

export const attributeInputSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(60),
    slug: slug.optional(),
    type: z.enum(["TEXT", "NUMBER", "SELECT", "MULTI_SELECT", "COLOR", "BOOLEAN", "RANGE"]),
    unit: optionalText(12),
    isFilterable: z.boolean(),
    showInSpecs: z.boolean(),
    values: z
      .array(z.object({ id: id.optional(), value: z.string().trim().min(1, "Enter a value.").max(60), swatchHex: hex.nullable().optional().transform((v) => v ?? null) }))
      .max(200),
  })
  .superRefine((a, ctx) => {
    const usesValues = ["SELECT", "MULTI_SELECT", "COLOR"].includes(a.type);
    if (usesValues && !a.values.length) ctx.addIssue({ code: "custom", path: ["values"], message: "Add at least one value." });
    if (!usesValues && a.values.length) ctx.addIssue({ code: "custom", path: ["values"], message: "This type doesn't use a value list." });
    const vals = a.values.map((v) => v.value.toLowerCase());
    vals.forEach((v, i) => vals.indexOf(v) !== i && ctx.addIssue({ code: "custom", path: ["values", i, "value"], message: "Values must be unique." }));
  });

// ── Brands ───────────────────────────────────────────────────────────────────

export const brandInputSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(60),
  slug: slug.optional(),
  description: optionalText(500),
  logoId: id.nullable(),
  isFeatured: z.boolean(),
});

// ── Media ────────────────────────────────────────────────────────────────────

/** DESIGN.md §8.5: alt text is required unless the image is marked decorative. */
export const mediaMetaSchema = z
  .object({ alt: z.string().trim().max(200), isDecorative: z.boolean() })
  .refine((m) => m.isDecorative || m.alt.length > 0, { path: ["alt"], message: "Describe the image for people who can't see it, or mark it decorative." });
