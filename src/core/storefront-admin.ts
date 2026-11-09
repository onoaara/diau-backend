import { z } from "zod";
import { safeHref } from "./href";
import { MENU_ICONS } from "./navigation";
import { SECTION_TYPES, sectionBaseSchema, sectionInputSchema, type SectionType } from "./sections";

/**
 * Admin input schemas for the storefront builder (pages, sections), banners and
 * navigation menus. Drafts are saved leniently (work in progress autosaves);
 * publishing validates every section strictly.
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color like #0E7C66.");
const iso = z.iso.datetime({ offset: true });
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

// ── Builder ──────────────────────────────────────────────────────────────────

/** Draft ids: real section ids, or client-made ones ("new-…") for unpublished sections. */
export const draftSectionId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);

export const draftSectionSchema = z.object({
  id: draftSectionId,
  type: z.enum(SECTION_TYPES as [SectionType, ...SectionType[]]),
  name: z.string().max(80).nullish(),
  title: z.string().max(120).nullish(),
  subtitle: z.string().max(240).nullish(),
  seeAllUrl: z.string().max(500).nullish(),
  isVisible: z.boolean(),
  device: z.enum(["ALL", "DESKTOP", "MOBILE"]),
  startsAt: iso.nullish(),
  endsAt: iso.nullish(),
  background: z
    .object({ style: z.enum(["none", "subtle", "brand", "color", "image"]), color: z.string().max(7).optional(), imageId: z.string().max(40).optional() })
    .nullish(),
  /** Validated against the type's schema on publish (and reported as issues on save). */
  config: z.record(z.string(), z.unknown()),
});
export type DraftSection = z.infer<typeof draftSectionSchema>;

export const draftInputSchema = z.object({
  sections: z
    .array(draftSectionSchema)
    .max(60, "Up to 60 sections per page.")
    .refine((s) => new Set(s.map((x) => x.id)).size === s.length, "Section ids must be unique."),
});

export type SectionIssue = { sectionId: string; path: string; message: string };

/** Strict checks for one draft section (what publish requires). */
export function sectionIssues(s: DraftSection): SectionIssue[] {
  const issues: SectionIssue[] = [];
  const parsed = sectionInputSchema.safeParse(s);
  if (!parsed.success) {
    for (const i of parsed.error.issues) issues.push({ sectionId: s.id, path: i.path.map(String).join("."), message: i.message });
  }
  if (s.seeAllUrl && !safeHref(s.seeAllUrl)) issues.push({ sectionId: s.id, path: "seeAllUrl", message: "Use a path like /deals or an https:// link." });
  if (s.startsAt && s.endsAt && Date.parse(s.endsAt) <= Date.parse(s.startsAt)) issues.push({ sectionId: s.id, path: "endsAt", message: "End must be after start." });
  if (s.background?.style === "color" && !(s.background.color && hex.safeParse(s.background.color).success)) {
    issues.push({ sectionId: s.id, path: "background.color", message: "Pick a background color." });
  }
  if (s.background?.style === "image" && !s.background.imageId) issues.push({ sectionId: s.id, path: "background.imageId", message: "Choose a background image." });
  return issues;
}

/** Strictly parsed section ready to store (publish). */
export function toPublishedSection(s: DraftSection) {
  const base = sectionBaseSchema.parse(s);
  const typed = sectionInputSchema.parse(s);
  return {
    type: s.type,
    name: base.name ?? null,
    title: base.title?.trim() || null,
    subtitle: base.subtitle?.trim() || null,
    seeAllUrl: base.seeAllUrl?.trim() || null,
    isVisible: base.isVisible,
    device: base.device,
    startsAt: base.startsAt ?? null,
    endsAt: base.endsAt ?? null,
    background: base.background && base.background.style !== "none" ? base.background : null,
    config: typed.config,
  };
}

export const pageMetaSchema = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(120),
  seoTitle: optionalText(70),
  seoDescription: optionalText(160),
});

// ── Banners ──────────────────────────────────────────────────────────────────

export const bannerInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name the banner (only admins see it).").max(80),
    desktopImageId: z.string().min(1, "Choose a desktop image."),
    mobileImageId: z.string().nullable(),
    headline: optionalText(80),
    subtext: optionalText(160),
    ctaLabel: optionalText(30),
    linkUrl: optionalText(500).refine((v) => v === null || safeHref(v) !== null, "Use a path like /deals or an https:// link."),
    ctaStyle: z.enum(["accent", "brand", "light"]),
    layout: z.enum(["text-left", "text-right", "image-only"]),
    backgroundColor: hex.nullable(),
    textTone: z.enum(["light", "dark"]),
    startsAt: z.coerce.date().nullable(),
    endsAt: z.coerce.date().nullable(),
    isActive: z.boolean(),
  })
  .superRefine((b, ctx) => {
    if (b.startsAt && b.endsAt && b.endsAt <= b.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start." });
    if (b.ctaLabel && !b.linkUrl) ctx.addIssue({ code: "custom", path: ["linkUrl"], message: "A button needs a link." });
    if (b.layout !== "image-only" && !b.headline) ctx.addIssue({ code: "custom", path: ["headline"], message: "Add a headline, or use the image-only layout." });
  });
export type BannerInput = z.infer<typeof bannerInputSchema>;

// ── Navigation ───────────────────────────────────────────────────────────────

export type MenuItemInput = {
  kind: "LINK" | "CATEGORY" | "COLUMN" | "FEATURED";
  label: string;
  url: string | null;
  categoryId: string | null;
  imageId: string | null;
  description: string | null;
  icon: string | null;
  badge: string | null;
  isVisible: boolean;
  openInNewTab: boolean;
  children: MenuItemInput[];
};

export const menuItemInputSchema: z.ZodType<MenuItemInput, unknown> = z
  .object({
    kind: z.enum(["LINK", "CATEGORY", "COLUMN", "FEATURED"]),
    label: z.string().trim().min(1, "Enter a label.").max(60),
    url: optionalText(500),
    categoryId: z.string().nullable(),
    imageId: z.string().nullable(),
    description: optionalText(120),
    icon: z
      .string()
      .nullable()
      .refine((v) => v === null || (MENU_ICONS as readonly string[]).includes(v), "Pick an icon from the list."),
    badge: optionalText(20),
    isVisible: z.boolean(),
    openInNewTab: z.boolean(),
    get children() {
      return z.array(menuItemInputSchema).max(60);
    },
  })
  .superRefine((m, ctx) => {
    if (m.url && !safeHref(m.url)) ctx.addIssue({ code: "custom", path: ["url"], message: "Use a path like /deals or an https:// link." });
    if (m.kind === "CATEGORY" && !m.categoryId) ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Choose a category." });
    if ((m.kind === "LINK" || m.kind === "FEATURED") && !m.url && !m.children.length) ctx.addIssue({ code: "custom", path: ["url"], message: "Add a link." });
  });

export const menuInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  items: z.array(menuItemInputSchema).max(60),
});

/** Depth and size limits per storefront menu (what each placement can render). */
export const MENU_RULES: Record<string, { maxDepth: number; maxItems: number; hint: string }> = {
  utility: { maxDepth: 1, maxItems: 8, hint: "Small links at the top of every page." },
  "category-strip": { maxDepth: 3, maxItems: 300, hint: "Tabs under the search bar. Each tab can open a mega-menu: columns (level 2) with links (level 3) and featured cards." },
  footer: { maxDepth: 2, maxItems: 80, hint: "Footer columns (level 1) with links (level 2)." },
  "footer-legal": { maxDepth: 1, maxItems: 10, hint: "Small legal links at the very bottom." },
  "mobile-bottom": { maxDepth: 1, maxItems: 5, hint: "Up to 5 icon tabs on phones (turn on in Site settings → Features)." },
};

export function menuDepth(items: MenuItemInput[]): number {
  return items.reduce((d, i) => Math.max(d, 1 + menuDepth(i.children)), 0);
}
export function menuCount(items: MenuItemInput[]): number {
  return items.reduce((n, i) => n + 1 + menuCount(i.children), 0);
}
