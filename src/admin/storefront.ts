import { MENU_KEYS, MENU_RULES, menuCount, menuDepth, type BannerInput, type MenuItemInput } from "../core";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { destroyImage, isCloudinaryConfigured } from "../lib/cloudinary";
import { HttpError, notFound } from "../lib/errors";
import { mediaSelect, toMediaDto } from "../lib/media";

// ── Banners ──────────────────────────────────────────────────────────────────

const bannerSelect = {
  id: true,
  name: true,
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
  updatedAt: true,
  desktopImage: { select: mediaSelect },
  mobileImage: { select: mediaSelect },
} as const;

/** Sections (published or in a draft) whose config lists this banner. */
async function bannerUsage(): Promise<Map<string, string[]>> {
  const [sections, pages] = await Promise.all([
    prisma.section.findMany({ where: { type: { in: ["hero", "promo-banner"] } }, select: { config: true, page: { select: { title: true } } } }),
    prisma.page.findMany({ where: { draftUpdatedAt: { not: null } }, select: { title: true, draft: true } }),
  ]);
  const usage = new Map<string, string[]>();
  const add = (ids: unknown, where: string) => {
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (typeof id === "string") usage.set(id, [...new Set([...(usage.get(id) ?? []), where])]);
  };
  for (const s of sections) add((s.config as { bannerIds?: unknown })?.bannerIds, s.page.title);
  for (const p of pages) {
    if (!Array.isArray(p.draft)) continue;
    for (const s of p.draft as Array<{ config?: { bannerIds?: unknown } }>) add(s?.config?.bannerIds, `${p.title} (draft)`);
  }
  return usage;
}

export async function listBanners() {
  const [rows, usage] = await Promise.all([prisma.banner.findMany({ orderBy: { updatedAt: "desc" }, select: bannerSelect }), bannerUsage()]);
  const now = new Date();
  return rows.map(({ desktopImage, mobileImage, ...b }) => ({
    ...b,
    startsAt: b.startsAt?.toISOString() ?? null,
    endsAt: b.endsAt?.toISOString() ?? null,
    updatedAt: b.updatedAt.toISOString(),
    desktopImage: toMediaDto(desktopImage)!,
    mobileImage: toMediaDto(mobileImage),
    state: !b.isActive ? "off" : b.startsAt && b.startsAt > now ? "scheduled" : b.endsAt && b.endsAt <= now ? "ended" : "live",
    usedIn: usage.get(b.id) ?? [],
  }));
}

async function checkBannerImages(input: BannerInput) {
  const ids = [input.desktopImageId, input.mobileImageId].filter((x): x is string => !!x);
  const found = await prisma.mediaAsset.count({ where: { id: { in: ids } } });
  if (found !== new Set(ids).size) throw new HttpError(422, "validation_error", "An image no longer exists.", { desktopImageId: ["Choose the image again."] });
}

export async function saveBanner(id: string | null, input: BannerInput) {
  await checkBannerImages(input);
  if (id) {
    const before = await prisma.banner.findUnique({ where: { id } });
    if (!before) throw notFound("Banner");
    const b = await prisma.banner.update({ where: { id }, data: input, select: { id: true, name: true } });
    return { banner: b, before };
  }
  const b = await prisma.banner.create({ data: input, select: { id: true, name: true } });
  return { banner: b, before: null };
}

export async function deleteBanner(id: string) {
  const b = await prisma.banner.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!b) throw notFound("Banner");
  const used = (await bannerUsage()).get(id) ?? [];
  if (used.length) throw new HttpError(409, "in_use", `“${b.name}” is used on ${used.join(", ")}. Remove it from those sections first, or switch it off instead.`);
  await prisma.banner.delete({ where: { id } });
  return b;
}

// ── Navigation ───────────────────────────────────────────────────────────────

const MENU_NAMES: Record<string, string> = {
  utility: "Header utility links",
  "category-strip": "Category tab strip & mega-menu",
  footer: "Footer columns",
  "footer-legal": "Footer legal links",
  "mobile-bottom": "Mobile bottom navigation",
};

export async function listMenus() {
  // The storefront's menus always exist, even before anyone adds items.
  await prisma.navigationMenu.createMany({ data: MENU_KEYS.map((key) => ({ key, name: MENU_NAMES[key] ?? key })), skipDuplicates: true });
  const rows = await prisma.navigationMenu.findMany({ orderBy: { createdAt: "asc" }, select: { key: true, name: true, updatedAt: true, _count: { select: { items: true } } } });
  return rows.map(({ _count, ...m }) => ({ ...m, itemCount: _count.items, rules: MENU_RULES[m.key] ?? { maxDepth: 3, maxItems: 100, hint: "Custom menu." } }));
}

type ItemRow = Prisma.MenuItemGetPayload<{ select: typeof itemSelect }>;
const itemSelect = {
  id: true,
  parentId: true,
  position: true,
  kind: true,
  label: true,
  url: true,
  categoryId: true,
  description: true,
  icon: true,
  badge: true,
  isVisible: true,
  openInNewTab: true,
  image: { select: mediaSelect },
  category: { select: { name: true, slug: true } },
} as const;

export type MenuItemEdit = Omit<MenuItemInput, "children" | "imageId"> & {
  id: string;
  image: ReturnType<typeof toMediaDto>;
  categoryName: string | null;
  children: MenuItemEdit[];
};

export async function readMenuForEdit(key: string) {
  const menu = await prisma.navigationMenu.findUnique({ where: { key }, select: { key: true, name: true, updatedAt: true, items: { select: itemSelect } } });
  if (!menu) return null;
  const byParent = new Map<string | null, ItemRow[]>();
  for (const r of menu.items) byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);
  const build = (parent: string | null, depth: number): MenuItemEdit[] =>
    depth > 5
      ? []
      : (byParent.get(parent) ?? [])
          .sort((a, b) => a.position - b.position)
          .map((r) => ({
            id: r.id,
            kind: r.kind,
            label: r.label,
            url: r.url,
            categoryId: r.categoryId,
            categoryName: r.category?.name ?? null,
            image: toMediaDto(r.image),
            description: r.description,
            icon: r.icon,
            badge: r.badge,
            isVisible: r.isVisible,
            openInNewTab: r.openInNewTab,
            children: build(r.id, depth + 1),
          }));
  return { key: menu.key, name: menu.name, updatedAt: menu.updatedAt.toISOString(), rules: MENU_RULES[menu.key] ?? { maxDepth: 3, maxItems: 100, hint: "Custom menu." }, items: build(null, 0) };
}

/** Replaces a menu's items with the submitted tree (one transaction). */
export async function saveMenu(key: string, input: { name: string; items: MenuItemInput[] }) {
  const menu = await prisma.navigationMenu.findUnique({ where: { key }, select: { id: true } });
  if (!menu) throw notFound("Menu");
  const rules = MENU_RULES[key] ?? { maxDepth: 3, maxItems: 100 };
  if (menuDepth(input.items) > rules.maxDepth) throw new HttpError(422, "validation_error", `This menu can only be ${rules.maxDepth} level${rules.maxDepth === 1 ? "" : "s"} deep.`);
  if (menuCount(input.items) > rules.maxItems) throw new HttpError(422, "validation_error", `This menu holds up to ${rules.maxItems} items.`);

  const walk = (items: MenuItemInput[]): MenuItemInput[] => items.flatMap((i) => [i, ...walk(i.children)]);
  const flat = walk(input.items);
  const catIds = [...new Set(flat.map((i) => i.categoryId).filter((x): x is string => !!x))];
  const imgIds = [...new Set(flat.map((i) => i.imageId).filter((x): x is string => !!x))];
  const [cats, imgs] = await Promise.all([prisma.category.count({ where: { id: { in: catIds } } }), prisma.mediaAsset.count({ where: { id: { in: imgIds } } })]);
  if (cats !== catIds.length) throw new HttpError(422, "validation_error", "A chosen category no longer exists. Pick it again.");
  if (imgs !== imgIds.length) throw new HttpError(422, "validation_error", "A chosen image no longer exists. Pick it again.");

  await prisma.$transaction(async (tx) => {
    await tx.menuItem.deleteMany({ where: { menuId: menu.id } });
    const create = async (items: MenuItemInput[], parentId: string | null) => {
      for (const [position, { children, ...item }] of items.entries()) {
        const row = await tx.menuItem.create({ data: { ...item, menuId: menu.id, parentId, position }, select: { id: true } });
        if (children.length) await create(children, row.id);
      }
    };
    await create(input.items, null);
    await tx.navigationMenu.update({ where: { id: menu.id }, data: { name: input.name } });
  });
  return { count: flat.length };
}

// ── Media ────────────────────────────────────────────────────────────────────

/** Where an image is used, as readable labels ("3 products", "Theme logo"). */
export async function mediaUsage(id: string): Promise<string[]> {
  const m = await prisma.mediaAsset.findUnique({
    where: { id },
    select: {
      _count: {
        select: {
          productImages: true,
          variantImages: true,
          brandLogos: true,
          categoryImages: true,
          categoryBanners: true,
          bannerDesktop: true,
          bannerMobile: true,
          menuItems: true,
          reviewImages: true,
          themeLogos: true,
          themeLogosDark: true,
          themeFavicons: true,
        },
      },
    },
  });
  if (!m) throw notFound("Image");
  const c = m._count;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const out: string[] = [];
  if (c.productImages + c.variantImages) out.push(plural(c.productImages + c.variantImages, "product image"));
  if (c.brandLogos) out.push(plural(c.brandLogos, "brand logo"));
  if (c.categoryImages + c.categoryBanners) out.push(plural(c.categoryImages + c.categoryBanners, "category image"));
  if (c.bannerDesktop + c.bannerMobile) out.push(plural(c.bannerDesktop + c.bannerMobile, "banner"));
  if (c.menuItems) out.push(plural(c.menuItems, "menu item"));
  if (c.reviewImages) out.push(plural(c.reviewImages, "review photo"));
  if (c.themeLogos + c.themeLogosDark + c.themeFavicons) out.push("the theme (logo or favicon)");
  // Section background images live in JSON.
  const bg = await prisma.section.count({ where: { background: { path: ["imageId"], equals: id } } });
  if (bg) out.push(plural(bg, "section background"));
  return out;
}

export async function deleteMedia(id: string) {
  const m = await prisma.mediaAsset.findUnique({ where: { id }, select: { id: true, publicId: true, alt: true, provider: true } });
  if (!m) throw notFound("Image");
  const used = await mediaUsage(id);
  if (used.length) throw new HttpError(409, "in_use", `This image is used by ${used.join(", ")}. Replace it there first.`);
  await prisma.mediaAsset.delete({ where: { id } });
  // Storage cleanup is best effort: the record is gone either way.
  if (m.publicId && m.provider === "CLOUDINARY" && isCloudinaryConfigured()) await destroyImage(m.publicId).catch(() => {});
  return m;
}

