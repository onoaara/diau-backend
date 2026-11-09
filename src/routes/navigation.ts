import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isMenuIcon, menuKeySchema, safeHref } from "../core";
import { prisma } from "../db";
import { mediaDtoSchema, mediaSelect, toMediaDto } from "../lib/media";
import { buildTree } from "../lib/tree";

export type MenuItemDto = {
  id: string;
  kind: "LINK" | "CATEGORY" | "COLUMN" | "FEATURED";
  label: string;
  href: string | null;
  description: string | null;
  icon: string | null;
  badge: string | null;
  openInNewTab: boolean;
  image: z.infer<typeof mediaDtoSchema> | null;
  children: MenuItemDto[];
};

const menuItemDto: z.ZodType<MenuItemDto> = z.object({
  id: z.string(),
  kind: z.enum(["LINK", "CATEGORY", "COLUMN", "FEATURED"]),
  label: z.string(),
  href: z.string().nullable(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  badge: z.string().nullable(),
  openInNewTab: z.boolean(),
  image: mediaDtoSchema.nullable(),
  get children() {
    return z.array(menuItemDto);
  },
});

const menuResponse = z.object({ key: z.string(), name: z.string(), items: z.array(menuItemDto) });

export const categoryNodeDto: z.ZodType<CategoryNodeDto> = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  icon: z.string().nullable(),
  get children() {
    return z.array(categoryNodeDto);
  },
});
export type CategoryNodeDto = { id: string; name: string; slug: string; icon: string | null; children: CategoryNodeDto[] };

export async function readMenu(key: string) {
  const menu = await prisma.navigationMenu.findUnique({
    where: { key },
    select: {
      key: true,
      name: true,
      items: {
        where: { isVisible: true },
        select: {
          id: true,
          parentId: true,
          position: true,
          kind: true,
          label: true,
          url: true,
          description: true,
          icon: true,
          badge: true,
          openInNewTab: true,
          image: { select: mediaSelect },
          category: { select: { slug: true, isVisible: true } },
        },
      },
    },
  });
  if (!menu) return { key, name: key, items: [] };

  const items = buildTree<(typeof menu.items)[number], MenuItemDto>(menu.items, (row, children) => {
    // Category-backed items follow the category's live slug and visibility.
    if (row.category && !row.category.isVisible) return null;
    const href = row.category ? `/c/${row.category.slug}` : safeHref(row.url);
    // A plain link with nowhere to go and nothing under it is useless to shoppers.
    if (!href && children.length === 0 && row.kind !== "COLUMN") return null;
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      href,
      description: row.description,
      icon: isMenuIcon(row.icon) ? row.icon : null,
      badge: row.badge,
      openInNewTab: row.openInNewTab,
      image: toMediaDto(row.image),
      children,
    };
  });
  return { key: menu.key, name: menu.name, items };
}

/** Visible categories (and their visible ancestors) as a tree, ordered by admin position. */
export async function readCategoryTree() {
  const rows = await prisma.category.findMany({
    where: { isVisible: true, showInMenu: true },
    select: { id: true, parentId: true, position: true, name: true, slug: true, icon: true },
  });
  return buildTree<(typeof rows)[number], CategoryNodeDto>(rows, (row, children) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    children,
  }));
}

export const navigationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/navigation/:key",
    {
      schema: {
        tags: ["storefront"],
        params: z.object({ key: menuKeySchema }),
        response: { 200: menuResponse },
      },
    },
    async (req) => readMenu(req.params.key),
  );

  app.get(
    "/categories/tree",
    { schema: { tags: ["storefront"], response: { 200: z.array(categoryNodeDto) } } },
    async () => readCategoryTree(),
  );
};
