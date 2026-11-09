import { z } from "zod";
import {
  attributeInputSchema,
  brandInputSchema,
  categoryFiltersInputSchema,
  categoryInputSchema,
  createsCycle,
  slugify,
} from "../core";
import { prisma } from "../db";
import { conflict, HttpError, notFound } from "../lib/errors";
import { mediaSelect, toMediaDto } from "../lib/media";
import { rethrowUnique, uniqueSlug } from "./util";

// ── Reference data for admin forms ───────────────────────────────────────────

export async function catalogReference() {
  const [categories, brands, attributes] = await Promise.all([
    prisma.category.findMany({ orderBy: [{ position: "asc" }], select: { id: true, name: true, parentId: true, position: true, isVisible: true } }),
    prisma.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.attribute.findMany({
      orderBy: [{ position: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true, unit: true, isFilterable: true, showInSpecs: true, values: { orderBy: { position: "asc" }, select: { id: true, value: true, swatchHex: true } } },
    }),
  ]);
  return { categories, brands, attributes };
}

// ── Categories ───────────────────────────────────────────────────────────────

export async function listCategories() {
  const rows = await prisma.category.findMany({
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      slug: true,
      parentId: true,
      position: true,
      icon: true,
      description: true,
      seoTitle: true,
      seoDescription: true,
      isVisible: true,
      showInMenu: true,
      featuredOnHome: true,
      image: { select: mediaSelect },
      banner: { select: mediaSelect },
      _count: { select: { products: true, children: true } },
    },
  });
  return rows.map(({ image, banner, _count, ...c }) => ({
    ...c,
    image: toMediaDto(image),
    banner: toMediaDto(banner),
    productCount: _count.products,
    childCount: _count.children,
  }));
}

const categorySlugTaken = (exceptId: string | null) => async (slug: string) =>
  Boolean(await prisma.category.findFirst({ where: { slug, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } }));

export async function saveCategory(id: string | null, input: z.infer<typeof categoryInputSchema>) {
  const existing = id ? await prisma.category.findUnique({ where: { id }, select: { id: true, slug: true } }) : null;
  if (id && !existing) throw notFound("Category");
  if (input.parentId) {
    const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
    const next = all.map((c) => (c.id === id ? { ...c, parentId: input.parentId } : c));
    if (!all.some((c) => c.id === input.parentId)) throw new HttpError(400, "validation_error", "Check the highlighted fields.", { parentId: ["Parent not found."] });
    if (id && createsCycle(next)) throw new HttpError(400, "validation_error", "Check the highlighted fields.", { parentId: ["A category can't be inside itself or its own subcategories."] });
  }
  for (const [field, mediaId] of [["imageId", input.imageId], ["bannerId", input.bannerId]] as const) {
    if (mediaId && !(await prisma.mediaAsset.findUnique({ where: { id: mediaId }, select: { id: true } }))) {
      throw new HttpError(400, "validation_error", "Check the highlighted fields.", { [field]: ["Image not found."] });
    }
  }
  const slug = input.slug ?? existing?.slug ?? (await uniqueSlug(input.name, categorySlugTaken(null)));
  const { slug: _s, ...rest } = input;
  try {
    if (existing) {
      await prisma.category.update({ where: { id: existing.id }, data: { ...rest, slug } });
      return { id: existing.id, slug, previousSlug: existing.slug };
    }
    const position = await prisma.category.count({ where: { parentId: input.parentId } });
    const created = await prisma.category.create({ data: { ...rest, slug, position }, select: { id: true } });
    return { id: created.id, slug, previousSlug: null };
  } catch (err) {
    rethrowUnique(err, { slug: "slug" });
  }
}

/** Applies a drag-and-drop (or keyboard) rearrangement of the whole tree. */
export async function reorderCategories(items: Array<{ id: string; parentId: string | null; position: number }>) {
  const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
  const byId = new Map(all.map((c) => [c.id, c]));
  if (items.some((i) => !byId.has(i.id) || (i.parentId && !byId.has(i.parentId)))) throw new HttpError(400, "stale_tree", "The category list changed. Reload and try again.");
  const merged = all.map((c) => {
    const moved = items.find((i) => i.id === c.id);
    return moved ? { id: c.id, parentId: moved.parentId } : c;
  });
  if (createsCycle(merged)) throw new HttpError(400, "invalid_move", "A category can't be moved inside its own subcategories.");
  await prisma.$transaction(items.map((i) => prisma.category.update({ where: { id: i.id }, data: { parentId: i.parentId, position: i.position } })));
}

export async function deleteCategory(id: string) {
  const c = await prisma.category.findUnique({ where: { id }, select: { id: true, name: true, slug: true, _count: { select: { products: true, children: true } } } });
  if (!c) throw notFound("Category");
  if (c._count.children) throw conflict(`"${c.name}" has ${c._count.children} subcategories. Move or delete them first.`);
  if (c._count.products) throw conflict(`"${c.name}" has ${c._count.products} products. Move them to another category first.`);
  await prisma.category.delete({ where: { id } });
  return c;
}

// ── Category filters ─────────────────────────────────────────────────────────

export async function readCategoryFilters(categoryId: string) {
  const cats = await prisma.category.findMany({ select: { id: true, name: true, parentId: true } });
  const byId = new Map(cats.map((c) => [c.id, c]));
  if (!byId.has(categoryId)) throw notFound("Category");
  const ancestors: Array<{ id: string; name: string }> = [];
  for (let c = byId.get(byId.get(categoryId)!.parentId ?? ""), guard = 0; c && guard < 10; c = c.parentId ? byId.get(c.parentId) : undefined, guard++) ancestors.push({ id: c.id, name: c.name });
  const rows = await prisma.categoryAttribute.findMany({
    where: { categoryId: { in: [categoryId, ...ancestors.map((a) => a.id)] } },
    orderBy: { position: "asc" },
    select: { categoryId: true, builtIn: true, attributeId: true, label: true, displayType: true, isCollapsed: true, inheritToChildren: true, attribute: { select: { name: true } } },
  });
  const own = rows.filter((r) => r.categoryId === categoryId);
  // Inherited from the nearest ancestor that defines each filter (and isn't overridden here).
  const ownKeys = new Set(own.map((r) => r.builtIn ?? r.attributeId));
  const inherited: Array<(typeof rows)[number] & { from: string }> = [];
  const seen = new Set<string>();
  for (const a of ancestors) {
    for (const r of rows.filter((x) => x.categoryId === a.id && x.inheritToChildren)) {
      const key = (r.builtIn ?? r.attributeId)!;
      if (ownKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      inherited.push({ ...r, from: a.name });
    }
  }
  const view = (r: (typeof rows)[number]) => ({
    builtIn: r.builtIn,
    attributeId: r.attributeId,
    attributeName: r.attribute?.name ?? null,
    label: r.label,
    displayType: r.displayType,
    isCollapsed: r.isCollapsed,
    inheritToChildren: r.inheritToChildren,
  });
  return { own: own.map(view), inherited: inherited.map((r) => ({ ...view(r), from: r.from })) };
}

export async function saveCategoryFilters(categoryId: string, input: z.infer<typeof categoryFiltersInputSchema>) {
  if (!(await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } }))) throw notFound("Category");
  const attrIds = input.filters.flatMap((f) => (f.attributeId ? [f.attributeId] : []));
  const attrs = await prisma.attribute.findMany({ where: { id: { in: attrIds } }, select: { id: true, type: true, isFilterable: true } });
  input.filters.forEach((f, i) => {
    if (!f.attributeId) return;
    const a = attrs.find((x) => x.id === f.attributeId);
    if (!a) throw new HttpError(400, "validation_error", "Check the highlighted fields.", { [`filters.${i}`]: ["Attribute not found."] });
    if (!a.isFilterable) throw new HttpError(400, "validation_error", "Check the highlighted fields.", { [`filters.${i}`]: ["This attribute isn't filterable. Turn on \"Use as filter\" first."] });
    if (f.displayType === "SWATCH" && a.type !== "COLOR") throw new HttpError(400, "validation_error", "Check the highlighted fields.", { [`filters.${i}`]: ["Swatches need a Color attribute."] });
  });
  await prisma.$transaction([
    prisma.categoryAttribute.deleteMany({ where: { categoryId } }),
    prisma.categoryAttribute.createMany({
      data: input.filters.map((f, i) => ({
        categoryId,
        builtIn: f.builtIn,
        attributeId: f.attributeId,
        label: f.label,
        displayType: f.displayType,
        isCollapsed: f.isCollapsed,
        inheritToChildren: f.inheritToChildren,
        position: i * 10,
      })),
    }),
  ]);
}

// ── Attributes ───────────────────────────────────────────────────────────────

export async function listAttributes() {
  const rows = await prisma.attribute.findMany({
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      slug: true,
      type: true,
      unit: true,
      isFilterable: true,
      showInSpecs: true,
      values: { orderBy: { position: "asc" }, select: { id: true, value: true, slug: true, swatchHex: true, _count: { select: { productAttributes: true } } } },
      _count: { select: { productAttributes: true, categoryAttributes: true } },
    },
  });
  return rows.map(({ _count, values, ...a }) => ({
    ...a,
    values: values.map(({ _count: vc, ...v }) => ({ ...v, productCount: vc.productAttributes })),
    usage: { productValues: _count.productAttributes, categoryFilters: _count.categoryAttributes },
  }));
}

export async function saveAttribute(id: string | null, input: z.infer<typeof attributeInputSchema>) {
  const existing = id ? await prisma.attribute.findUnique({ where: { id }, select: { id: true, slug: true, type: true, _count: { select: { productAttributes: true } } } }) : null;
  if (id && !existing) throw notFound("Attribute");
  if (existing && existing.type !== input.type && existing._count.productAttributes > 0) {
    throw new HttpError(400, "validation_error", "Check the highlighted fields.", { type: ["Products already use this attribute, so its type can't change."] });
  }
  const slug = input.slug ?? existing?.slug ?? (await uniqueSlug(input.name, async (s) => Boolean(await prisma.attribute.findUnique({ where: { slug: s }, select: { id: true } }))));
  try {
    return await prisma.$transaction(async (tx) => {
      const attr = existing
        ? await tx.attribute.update({ where: { id: existing.id }, data: { name: input.name, slug, type: input.type, unit: input.unit, isFilterable: input.isFilterable, showInSpecs: input.showInSpecs }, select: { id: true } })
        : await tx.attribute.create({ data: { name: input.name, slug, type: input.type, unit: input.unit, isFilterable: input.isFilterable, showInSpecs: input.showInSpecs, position: await tx.attribute.count() }, select: { id: true } });
      // Values: keep ids (products reference them), update, add, remove.
      const keep = input.values.flatMap((v) => (v.id ? [v.id] : []));
      await tx.attributeValue.deleteMany({ where: { attributeId: attr.id, id: { notIn: keep } } });
      // Park kept values on temporary slugs first, so renames that swap slugs between rows don't clash.
      for (const v of input.values) {
        if (v.id) await tx.attributeValue.updateMany({ where: { id: v.id, attributeId: attr.id }, data: { slug: `tmp-${v.id}` } });
      }
      const used = new Set<string>();
      for (const [i, v] of input.values.entries()) {
        let vslug = slugify(v.value) || `value-${i + 1}`;
        while (used.has(vslug)) vslug = `${vslug}-${i + 1}`;
        used.add(vslug);
        const data = { value: v.value, slug: vslug, swatchHex: input.type === "COLOR" ? v.swatchHex : null, position: i };
        if (v.id) {
          const r = await tx.attributeValue.updateMany({ where: { id: v.id, attributeId: attr.id }, data });
          if (!r.count) throw new HttpError(400, "validation_error", "Check the highlighted fields.", { [`values.${i}`]: ["This value no longer exists. Reload the page."] });
        } else {
          await tx.attributeValue.create({ data: { ...data, attributeId: attr.id } });
        }
      }
      // A filter display that no longer fits the type falls back to checkboxes.
      if (input.type !== "COLOR") await tx.categoryAttribute.updateMany({ where: { attributeId: attr.id, displayType: "SWATCH" }, data: { displayType: "CHECKBOX" } });
      if (!input.isFilterable) await tx.categoryAttribute.deleteMany({ where: { attributeId: attr.id } });
      return { id: attr.id, slug };
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    rethrowUnique(err, { slug: "slug" });
  }
}

export async function deleteAttribute(id: string) {
  const a = await prisma.attribute.findUnique({ where: { id }, select: { id: true, name: true, _count: { select: { productAttributes: true } } } });
  if (!a) throw notFound("Attribute");
  await prisma.attribute.delete({ where: { id } });
  return a;
}

// ── Brands ───────────────────────────────────────────────────────────────────

export async function listBrands() {
  const rows = await prisma.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, slug: true, description: true, isFeatured: true, logo: { select: mediaSelect }, _count: { select: { products: true } } } });
  return rows.map(({ logo, _count, ...b }) => ({ ...b, logo: toMediaDto(logo), productCount: _count.products }));
}

export async function saveBrand(id: string | null, input: z.infer<typeof brandInputSchema>) {
  const existing = id ? await prisma.brand.findUnique({ where: { id }, select: { id: true, slug: true } }) : null;
  if (id && !existing) throw notFound("Brand");
  if (input.logoId && !(await prisma.mediaAsset.findUnique({ where: { id: input.logoId }, select: { id: true } }))) {
    throw new HttpError(400, "validation_error", "Check the highlighted fields.", { logoId: ["Image not found."] });
  }
  const slug = input.slug ?? existing?.slug ?? (await uniqueSlug(input.name, async (s) => Boolean(await prisma.brand.findUnique({ where: { slug: s }, select: { id: true } }))));
  const { slug: _s, ...rest } = input;
  try {
    const b = existing
      ? await prisma.brand.update({ where: { id: existing.id }, data: { ...rest, slug }, select: { id: true } })
      : await prisma.brand.create({ data: { ...rest, slug }, select: { id: true } });
    return { id: b.id, slug };
  } catch (err) {
    rethrowUnique(err, { slug: "slug" });
  }
}

/** Deleting a brand keeps its products (they just lose the brand). */
export async function deleteBrand(id: string) {
  const b = await prisma.brand.findUnique({ where: { id }, select: { id: true, name: true, _count: { select: { products: true } } } });
  if (!b) throw notFound("Brand");
  await prisma.brand.delete({ where: { id } });
  return b;
}
