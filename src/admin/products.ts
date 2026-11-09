import { z } from "zod";
import { slugify, tiptapText, type ProductInput } from "../core";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { HttpError, notFound } from "../lib/errors";
import { rethrowUnique, uniqueSlug } from "./util";

// ── List ─────────────────────────────────────────────────────────────────────

export const productListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
  categoryId: z.string().max(40).optional(),
  brandId: z.string().max(40).optional(),
  stock: z.enum(["low", "out"]).optional(),
  sort: z.enum(["updated", "title", "price", "stock", "sold"]).default("updated"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().refine((n) => [25, 50, 100].includes(n)).default(25),
});

export async function listProducts(q: z.infer<typeof productListQuery>) {
  const where: Prisma.ProductWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.brandId ? { brandId: q.brandId } : {}),
    ...(q.q
      ? { OR: [{ title: { contains: q.q, mode: "insensitive" } }, { sku: { contains: q.q, mode: "insensitive" } }, { variants: { some: { sku: { contains: q.q, mode: "insensitive" } } } }] }
      : {}),
  };
  if (q.categoryId) {
    const ids = await prisma.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE scope AS (SELECT id FROM "Category" WHERE id = ${q.categoryId}
        UNION ALL SELECT c.id FROM "Category" c JOIN scope s ON c."parentId" = s.id)
      SELECT id FROM scope`;
    where.categoryId = { in: ids.map((r) => r.id) };
  }
  if (q.stock === "out") {
    where.AND = [{ trackInventory: true }, { OR: [{ variants: { none: {} }, stock: 0 }, { variants: { some: {} }, NOT: { variants: { some: { stock: { gt: 0 }, isActive: true } } } }] }];
  } else if (q.stock === "low") {
    where.AND = [{ trackInventory: true }, { OR: [{ variants: { none: {} }, stock: { gt: 0, lte: prisma.product.fields.lowStockThreshold } }, { variants: { some: { isActive: true, stock: { gt: 0, lte: 5 } } } }] }];
  }
  const orderBy: Prisma.ProductOrderByWithRelationInput[] = [
    q.sort === "title" ? { title: q.dir } : q.sort === "price" ? { priceCents: q.dir } : q.sort === "stock" ? { stock: q.dir } : q.sort === "sold" ? { soldCount: q.dir } : { updatedAt: q.dir },
    { id: "asc" },
  ];
  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        sku: true,
        priceCents: true,
        stock: true,
        trackInventory: true,
        lowStockThreshold: true,
        soldCount: true,
        updatedAt: true,
        publishAt: true,
        unpublishAt: true,
        category: { select: { name: true } },
        brand: { select: { name: true } },
        images: { orderBy: { position: "asc" }, take: 1, select: { media: { select: { url: true } } } },
        variants: { where: { isActive: true }, select: { stock: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);
  return {
    items: rows.map((p) => {
      const stock = p.variants.length ? p.variants.reduce((s, v) => s + v.stock, 0) : p.stock;
      return {
        id: p.id,
        title: p.title,
        slug: p.slug,
        status: p.status,
        sku: p.sku,
        priceCents: p.priceCents,
        stock,
        variantCount: p.variants.length,
        stockState: !p.trackInventory ? "untracked" : stock === 0 ? "out" : stock <= p.lowStockThreshold ? "low" : "ok",
        soldCount: p.soldCount,
        category: p.category.name,
        brand: p.brand?.name ?? null,
        imageUrl: p.images[0]?.media.url ?? null,
        scheduled: Boolean((p.publishAt && p.publishAt > new Date()) || p.unpublishAt),
        updatedAt: p.updatedAt.toISOString(),
      };
    }),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

// ── Read for editing ─────────────────────────────────────────────────────────

export async function readProductForEdit(id: string) {
  const p = await prisma.product.findUnique({
    where: { id },
    include: {
      tags: { select: { name: true } },
      images: { orderBy: { position: "asc" }, include: { media: { select: { id: true, url: true, alt: true, width: true, height: true } } } },
      options: { orderBy: { position: "asc" } },
      variants: { orderBy: { position: "asc" } },
      attributes: { select: { attributeId: true, valueId: true, textValue: true, numberValue: true, booleanValue: true } },
      _count: { select: { orderItems: true, reviews: true } },
    },
  });
  if (!p) return null;
  const attrs = new Map<string, { attributeId: string; valueIds: string[]; textValue: string | null; numberValue: number | null; booleanValue: boolean | null }>();
  for (const a of p.attributes) {
    const cur = attrs.get(a.attributeId) ?? { attributeId: a.attributeId, valueIds: [], textValue: null, numberValue: null, booleanValue: null };
    if (a.valueId) cur.valueIds.push(a.valueId);
    if (a.textValue !== null) cur.textValue = a.textValue;
    if (a.numberValue !== null) cur.numberValue = a.numberValue;
    if (a.booleanValue !== null) cur.booleanValue = a.booleanValue;
    attrs.set(a.attributeId, cur);
  }
  const optionValues = (raw: unknown) =>
    Array.isArray(raw)
      ? raw.flatMap((v) => (typeof v === "string" ? [{ value: v, swatchHex: null }] : v && typeof v === "object" && "value" in v ? [{ value: String(v.value), swatchHex: (v as { swatchHex?: string }).swatchHex ?? null }] : []))
      : [];
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    status: p.status,
    condition: p.condition,
    categoryId: p.categoryId,
    brandId: p.brandId,
    tags: p.tags.map((t) => t.name),
    description: p.description ?? null,
    priceCents: p.priceCents,
    compareAtPriceCents: p.compareAtPriceCents,
    sku: p.sku,
    stock: p.stock,
    trackInventory: p.trackInventory,
    lowStockThreshold: p.lowStockThreshold,
    freeShipping: p.freeShipping,
    location: p.location,
    weightGrams: p.weightGrams,
    shippingInfo: p.shippingInfo,
    returnsInfo: p.returnsInfo,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    videoUrl: p.videoUrl,
    publishAt: p.publishAt?.toISOString() ?? null,
    unpublishAt: p.unpublishAt?.toISOString() ?? null,
    images: p.images.map((i) => ({ mediaId: i.mediaId, alt: i.alt, media: i.media })),
    options: p.options.map((o) => ({ name: o.name, values: optionValues(o.values) })),
    variants: p.variants.map((v) => ({
      id: v.id,
      title: v.title,
      options: (v.options ?? {}) as Record<string, string>,
      priceCents: v.priceCents,
      compareAtPriceCents: v.compareAtPriceCents,
      stock: v.stock,
      sku: v.sku,
      imageId: v.imageId,
      isActive: v.isActive,
    })),
    attributes: [...attrs.values()],
    stats: { ratingAvg: p.ratingAvg, ratingCount: p.ratingCount, soldCount: p.soldCount, orderLines: p._count.orderItems, reviews: p._count.reviews },
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
export type ProductForEdit = NonNullable<Awaited<ReturnType<typeof readProductForEdit>>>;

// ── Save ─────────────────────────────────────────────────────────────────────

/** Brand, category path, tags and attribute values: indexed for search (weight B). */
async function buildSearchText(input: ProductInput): Promise<string> {
  const [brand, cats, values] = await Promise.all([
    input.brandId ? prisma.brand.findUnique({ where: { id: input.brandId }, select: { name: true } }) : null,
    prisma.category.findMany({ select: { id: true, name: true, parentId: true } }),
    prisma.attributeValue.findMany({ where: { id: { in: input.attributes.flatMap((a) => a.valueIds ?? []) } }, select: { value: true } }),
  ]);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const trail: string[] = [];
  for (let c = byId.get(input.categoryId), guard = 0; c && guard < 10; c = c.parentId ? byId.get(c.parentId) : undefined, guard++) trail.push(c.name);
  return [brand?.name, ...trail, ...input.tags, ...values.map((v) => v.value), ...input.attributes.map((a) => a.textValue ?? "")].filter(Boolean).join(" ").slice(0, 5000);
}

/** Checks references the schema can't (existence, ownership of attribute values, variant images). */
async function checkReferences(input: ProductInput) {
  const [category, brand, media, attrs] = await Promise.all([
    prisma.category.findUnique({ where: { id: input.categoryId }, select: { id: true } }),
    input.brandId ? prisma.brand.findUnique({ where: { id: input.brandId }, select: { id: true } }) : Promise.resolve({ id: "" }),
    prisma.mediaAsset.findMany({ where: { id: { in: [...input.images.map((i) => i.mediaId), ...input.variants.flatMap((v) => (v.imageId ? [v.imageId] : []))] } }, select: { id: true } }),
    prisma.attribute.findMany({ where: { id: { in: input.attributes.map((a) => a.attributeId) } }, select: { id: true, type: true, values: { select: { id: true } } } }),
  ]);
  const fields: Record<string, string[]> = {};
  if (!category) fields.categoryId = ["Choose a category."];
  if (!brand) fields.brandId = ["That brand no longer exists."];
  const mediaIds = new Set(media.map((m) => m.id));
  input.images.forEach((img, i) => !mediaIds.has(img.mediaId) && (fields[`images.${i}`] = ["Image not found. Remove it and upload again."]));
  const imageIds = new Set(input.images.map((i) => i.mediaId));
  input.variants.forEach((v, i) => v.imageId && !imageIds.has(v.imageId) && (fields[`variants.${i}.imageId`] = ["Pick one of the product's images."]));
  const attrById = new Map(attrs.map((a) => [a.id, a]));
  input.attributes.forEach((a, i) => {
    const def = attrById.get(a.attributeId);
    if (!def) fields[`attributes.${i}`] = ["Attribute not found."];
    else if (a.valueIds?.some((v) => !def.values.some((d) => d.id === v))) fields[`attributes.${i}`] = ["Pick values from this attribute's list."];
    else if (def.type !== "MULTI_SELECT" && (a.valueIds?.length ?? 0) > 1) fields[`attributes.${i}`] = ["Pick one value."];
  });
  if (Object.keys(fields).length) throw new HttpError(400, "validation_error", "Check the highlighted fields.", fields);
}

function attributeRows(input: ProductInput): Prisma.ProductAttributeCreateManyProductInput[] {
  return input.attributes.flatMap((a): Prisma.ProductAttributeCreateManyProductInput[] => {
    if (a.valueIds?.length) return a.valueIds.map((valueId) => ({ attributeId: a.attributeId, valueId }));
    if (a.textValue) return [{ attributeId: a.attributeId, textValue: a.textValue }];
    if (a.numberValue !== null && a.numberValue !== undefined) return [{ attributeId: a.attributeId, numberValue: a.numberValue }];
    if (a.booleanValue !== null && a.booleanValue !== undefined) return [{ attributeId: a.attributeId, booleanValue: a.booleanValue }];
    return [];
  });
}

/** Creates (id = null) or replaces a product. Returns the saved id and slugs to revalidate. */
export async function saveProduct(id: string | null, input: ProductInput) {
  const existing = id ? await prisma.product.findUnique({ where: { id }, select: { id: true, slug: true } }) : null;
  if (id && !existing) throw notFound("Product");
  await checkReferences(input);

  const slug = input.slug
    ? input.slug
    : existing?.slug ?? (await uniqueSlug(input.title, async (s) => Boolean(await prisma.product.findUnique({ where: { slug: s }, select: { id: true } }))));
  const searchText = await buildSearchText(input);
  const tagConnect = input.tags.map((name) => ({ where: { slug: slugify(name) }, create: { name, slug: slugify(name) } }));

  const data = {
    title: input.title,
    slug,
    status: input.status,
    condition: input.condition,
    categoryId: input.categoryId,
    brandId: input.brandId,
    description: (input.description ?? Prisma.DbNull) as Prisma.InputJsonValue,
    descriptionText: tiptapText(input.description),
    priceCents: input.priceCents,
    compareAtPriceCents: input.compareAtPriceCents,
    sku: input.sku,
    stock: input.variants.length ? 0 : input.stock,
    trackInventory: input.trackInventory,
    lowStockThreshold: input.lowStockThreshold,
    freeShipping: input.freeShipping,
    location: input.location,
    weightGrams: input.weightGrams,
    shippingInfo: input.shippingInfo,
    returnsInfo: input.returnsInfo,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
    videoUrl: input.videoUrl,
    publishAt: input.publishAt,
    unpublishAt: input.unpublishAt,
    searchText,
  };

  try {
    const saved = await prisma.$transaction(async (tx) => {
      const product = existing
        ? await tx.product.update({ where: { id: existing.id }, data: { ...data, tags: { set: [], connectOrCreate: tagConnect } }, select: { id: true } })
        : await tx.product.create({ data: { ...data, tags: { connectOrCreate: tagConnect } }, select: { id: true } });
      const pid = product.id;

      await tx.productImage.deleteMany({ where: { productId: pid } });
      if (input.images.length) await tx.productImage.createMany({ data: input.images.map((img, i) => ({ productId: pid, mediaId: img.mediaId, alt: img.alt, position: i })) });

      await tx.productOption.deleteMany({ where: { productId: pid } });
      if (input.options.length) {
        await tx.productOption.createMany({ data: input.options.map((o, i) => ({ productId: pid, name: o.name, position: i, values: o.values as unknown as Prisma.InputJsonValue })) });
      }

      // Variants: update by id (keeps carts and order history pointing at the same variant), create new, delete removed.
      const keep = input.variants.flatMap((v) => (v.id ? [v.id] : []));
      await tx.productVariant.deleteMany({ where: { productId: pid, id: { notIn: keep } } });
      for (const [i, v] of input.variants.entries()) {
        const vdata = {
          title: input.options.map((o) => v.options[o.name]).join(" / "),
          options: v.options,
          priceCents: v.priceCents,
          compareAtPriceCents: v.compareAtPriceCents,
          stock: v.stock,
          sku: v.sku,
          imageId: v.imageId,
          isActive: v.isActive,
          position: i,
        };
        if (v.id) {
          const updated = await tx.productVariant.updateMany({ where: { id: v.id, productId: pid }, data: vdata });
          if (updated.count === 0) throw new HttpError(400, "validation_error", "Check the highlighted fields.", { [`variants.${i}`]: ["This variant no longer exists. Reload the page."] });
        } else {
          await tx.productVariant.create({ data: { ...vdata, productId: pid } });
        }
      }

      await tx.productAttribute.deleteMany({ where: { productId: pid } });
      const rows = attributeRows(input);
      if (rows.length) await tx.productAttribute.createMany({ data: rows.map((r) => ({ ...r, productId: pid })) });
      return pid;
    });
    return { id: saved, slug, previousSlug: existing?.slug ?? null };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    rethrowUnique(err, { slug: "slug", sku: "sku" });
  }
}

export async function duplicateProduct(id: string) {
  const p = await readProductForEdit(id);
  if (!p) throw notFound("Product");
  const title = `Copy of ${p.title}`.slice(0, 200);
  const slug = await uniqueSlug(title, async (s) => Boolean(await prisma.product.findUnique({ where: { slug: s }, select: { id: true } })));
  const input: ProductInput = {
    title,
    slug,
    status: "DRAFT",
    condition: p.condition,
    categoryId: p.categoryId,
    brandId: p.brandId,
    tags: p.tags,
    description: p.description,
    priceCents: p.priceCents,
    compareAtPriceCents: p.compareAtPriceCents,
    sku: null, // SKUs are unique; the copy starts without one
    stock: p.stock,
    trackInventory: p.trackInventory,
    lowStockThreshold: p.lowStockThreshold,
    freeShipping: p.freeShipping,
    location: p.location,
    weightGrams: p.weightGrams,
    shippingInfo: p.shippingInfo,
    returnsInfo: p.returnsInfo,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    videoUrl: p.videoUrl,
    publishAt: null,
    unpublishAt: null,
    images: p.images.map((i) => ({ mediaId: i.mediaId, alt: i.alt })),
    options: p.options,
    variants: p.variants.map((v) => ({ options: v.options, priceCents: v.priceCents, compareAtPriceCents: v.compareAtPriceCents, stock: v.stock, sku: null, imageId: v.imageId, isActive: v.isActive })),
    attributes: p.attributes,
  };
  return saveProduct(null, input);
}

/**
 * Deletes a product. Order history keeps its own snapshot (title, price,
 * image), so past orders stay readable; carts and watchlists drop the item.
 */
export async function deleteProduct(id: string) {
  const p = await prisma.product.findUnique({ where: { id }, select: { id: true, slug: true, title: true } });
  if (!p) throw notFound("Product");
  await prisma.product.delete({ where: { id } });
  return p;
}

export const bulkInputSchema = z.object({
  ids: z.array(z.string().regex(/^[a-z0-9]{10,40}$/i)).min(1).max(500),
  action: z.enum(["status", "delete"]),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
});

export async function bulkProducts(input: z.infer<typeof bulkInputSchema>) {
  const products = await prisma.product.findMany({ where: { id: { in: input.ids } }, select: { id: true, slug: true } });
  if (input.action === "status") {
    if (!input.status) throw new HttpError(400, "validation_error", "Choose a status.");
    await prisma.product.updateMany({ where: { id: { in: products.map((p) => p.id) } }, data: { status: input.status } });
  } else {
    await prisma.product.deleteMany({ where: { id: { in: products.map((p) => p.id) } } });
  }
  return products;
}
