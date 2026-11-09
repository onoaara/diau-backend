import multipart from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  attributeInputSchema,
  brandInputSchema,
  categoryFiltersInputSchema,
  categoryInputSchema,
  categoryReorderSchema,
  mediaMetaSchema,
  productInputSchema,
  TAGS,
} from "../core";
import {
  catalogReference,
  deleteAttribute,
  deleteBrand,
  deleteCategory,
  listAttributes,
  listBrands,
  listCategories,
  readCategoryFilters,
  reorderCategories,
  saveAttribute,
  saveBrand,
  saveCategory,
  saveCategoryFilters,
} from "../admin/catalog";
import { ADMIN_UPLOAD, listMedia, mediaDto, mediaListQuery, updateMediaMeta, uploadMedia } from "../admin/media";
import { bulkInputSchema, bulkProducts, deleteProduct, duplicateProduct, listProducts, productListQuery, readProductForEdit, saveProduct } from "../admin/products";
import { audit } from "../lib/audit";
import { HttpError, notFound } from "../lib/errors";
import { revalidateFrontend } from "../lib/revalidate";
import { requirePermission } from "../plugins/auth";

const idParam = z.object({ id: z.string().regex(/^[a-z0-9]{10,40}$/i) });
const ok = z.object({ ok: z.literal(true) });
const saved = z.object({ id: z.string(), slug: z.string() });

/** Actor and IP for the audit log (requirePermission has loaded the user). */
const who = (req: FastifyRequest) => ({ actorId: req.authUser?.id ?? null, ip: req.ip });

export const adminCatalogRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(multipart, { limits: { fileSize: ADMIN_UPLOAD.maxBytes, files: 1, fields: 5 } });

  app.get("/admin/catalog/reference", { preHandler: requirePermission("products:read"), schema: { tags: ["admin"] } }, async () => catalogReference());

  // ── Products ────────────────────────────────────────────────────────────────
  app.get("/admin/products", { preHandler: requirePermission("products:read"), schema: { tags: ["admin"], querystring: productListQuery } }, async (req) => listProducts(req.query));

  app.get("/admin/products/:id", { preHandler: requirePermission("products:read"), schema: { tags: ["admin"], params: idParam } }, async (req) => {
    const p = await readProductForEdit(req.params.id);
    if (!p) throw notFound("Product");
    return p;
  });

  app.post(
    "/admin/products",
    { preHandler: requirePermission("products:write"), schema: { tags: ["admin"], body: productInputSchema, response: { 201: saved } } },
    async (req, reply) => {
      const r = await saveProduct(null, req.body);
      await audit({ ...who(req), action: "product.create", entity: "Product", entityId: r.id, summary: `Created product "${req.body.title}"` });
      revalidateFrontend([TAGS.products, TAGS.product(r.slug)]);
      return reply.code(201).send({ id: r.id, slug: r.slug });
    },
  );

  app.put(
    "/admin/products/:id",
    { preHandler: requirePermission("products:write"), schema: { tags: ["admin"], params: idParam, body: productInputSchema, response: { 200: saved } } },
    async (req) => {
      const before = await readProductForEdit(req.params.id);
      const r = await saveProduct(req.params.id, req.body);
      const after = await readProductForEdit(r.id);
      const strip = (p: typeof before) => (p ? { ...p, images: p.images.map((i) => i.mediaId), updatedAt: undefined, stats: undefined } : null);
      await audit({ ...who(req), action: "product.update", entity: "Product", entityId: r.id, summary: `Updated product "${req.body.title}"`, before: strip(before), after: strip(after) });
      revalidateFrontend([TAGS.products, TAGS.product(r.slug), ...(r.previousSlug && r.previousSlug !== r.slug ? [TAGS.product(r.previousSlug)] : [])]);
      return { id: r.id, slug: r.slug };
    },
  );

  app.post(
    "/admin/products/:id/duplicate",
    { preHandler: requirePermission("products:write"), schema: { tags: ["admin"], params: idParam, response: { 201: saved } } },
    async (req, reply) => {
      const r = await duplicateProduct(req.params.id);
      await audit({ ...who(req), action: "product.duplicate", entity: "Product", entityId: r.id, summary: `Duplicated product ${req.params.id} as a draft` });
      return reply.code(201).send({ id: r.id, slug: r.slug });
    },
  );

  app.delete("/admin/products/:id", { preHandler: requirePermission("products:write"), schema: { tags: ["admin"], params: idParam, response: { 200: ok } } }, async (req) => {
    const p = await deleteProduct(req.params.id);
    await audit({ ...who(req), action: "product.delete", entity: "Product", entityId: p.id, summary: `Deleted product "${p.title}"` });
    revalidateFrontend([TAGS.products, TAGS.product(p.slug)]);
    return { ok: true as const };
  });

  app.post(
    "/admin/products/bulk",
    { preHandler: requirePermission("products:write"), schema: { tags: ["admin"], body: bulkInputSchema, response: { 200: z.object({ count: z.number().int() }) } } },
    async (req) => {
      const items = await bulkProducts(req.body);
      const what = req.body.action === "delete" ? "Deleted" : `Set status ${req.body.status} on`;
      await audit({ ...who(req), action: `product.bulk_${req.body.action}`, entity: "Product", summary: `${what} ${items.length} products`, after: { ids: items.map((i) => i.id) } });
      revalidateFrontend([TAGS.products, ...items.map((i) => TAGS.product(i.slug))]);
      return { count: items.length };
    },
  );

  // ── Categories ──────────────────────────────────────────────────────────────
  const categoryTags = [TAGS.categories, TAGS.navigation, TAGS.filters, TAGS.products, TAGS.pages];

  app.get("/admin/categories", { preHandler: requirePermission("products:read"), schema: { tags: ["admin"] } }, async () => ({ items: await listCategories() }));

  app.post("/admin/categories", { preHandler: requirePermission("categories:write"), schema: { tags: ["admin"], body: categoryInputSchema, response: { 201: saved } } }, async (req, reply) => {
    const r = await saveCategory(null, req.body);
    await audit({ ...who(req), action: "category.create", entity: "Category", entityId: r.id, summary: `Created category "${req.body.name}"` });
    revalidateFrontend(categoryTags);
    return reply.code(201).send({ id: r.id, slug: r.slug });
  });

  app.put("/admin/categories/:id", { preHandler: requirePermission("categories:write"), schema: { tags: ["admin"], params: idParam, body: categoryInputSchema, response: { 200: saved } } }, async (req) => {
    const r = await saveCategory(req.params.id, req.body);
    await audit({ ...who(req), action: "category.update", entity: "Category", entityId: r.id, summary: `Updated category "${req.body.name}"`, after: { ...req.body } });
    revalidateFrontend(categoryTags);
    return { id: r.id, slug: r.slug };
  });

  app.post("/admin/categories/reorder", { preHandler: requirePermission("categories:write"), schema: { tags: ["admin"], body: categoryReorderSchema, response: { 200: ok } } }, async (req) => {
    await reorderCategories(req.body.items);
    await audit({ ...who(req), action: "category.reorder", entity: "Category", summary: `Rearranged ${req.body.items.length} categories` });
    revalidateFrontend(categoryTags);
    return { ok: true as const };
  });

  app.delete("/admin/categories/:id", { preHandler: requirePermission("categories:write"), schema: { tags: ["admin"], params: idParam, response: { 200: ok } } }, async (req) => {
    const c = await deleteCategory(req.params.id);
    await audit({ ...who(req), action: "category.delete", entity: "Category", entityId: c.id, summary: `Deleted category "${c.name}"` });
    revalidateFrontend(categoryTags);
    return { ok: true as const };
  });

  app.get("/admin/categories/:id/filters", { preHandler: requirePermission("products:read"), schema: { tags: ["admin"], params: idParam } }, async (req) => readCategoryFilters(req.params.id));

  app.put(
    "/admin/categories/:id/filters",
    { preHandler: requirePermission("attributes:write"), schema: { tags: ["admin"], params: idParam, body: categoryFiltersInputSchema, response: { 200: ok } } },
    async (req) => {
      await saveCategoryFilters(req.params.id, req.body);
      await audit({ ...who(req), action: "category.filters", entity: "Category", entityId: req.params.id, summary: `Updated filters (${req.body.filters.length})`, after: { filters: req.body.filters } });
      revalidateFrontend([TAGS.filters, TAGS.products]);
      return { ok: true as const };
    },
  );

  // ── Attributes ──────────────────────────────────────────────────────────────
  app.get("/admin/attributes", { preHandler: requirePermission("products:read"), schema: { tags: ["admin"] } }, async () => ({ items: await listAttributes() }));

  app.post("/admin/attributes", { preHandler: requirePermission("attributes:write"), schema: { tags: ["admin"], body: attributeInputSchema, response: { 201: saved } } }, async (req, reply) => {
    const r = await saveAttribute(null, req.body);
    await audit({ ...who(req), action: "attribute.create", entity: "Attribute", entityId: r.id, summary: `Created attribute "${req.body.name}"` });
    revalidateFrontend([TAGS.filters, TAGS.products]);
    return reply.code(201).send(r);
  });

  app.put("/admin/attributes/:id", { preHandler: requirePermission("attributes:write"), schema: { tags: ["admin"], params: idParam, body: attributeInputSchema, response: { 200: saved } } }, async (req) => {
    const r = await saveAttribute(req.params.id, req.body);
    await audit({ ...who(req), action: "attribute.update", entity: "Attribute", entityId: r.id, summary: `Updated attribute "${req.body.name}"`, after: { ...req.body } });
    revalidateFrontend([TAGS.filters, TAGS.products]);
    return r;
  });

  app.delete("/admin/attributes/:id", { preHandler: requirePermission("attributes:write"), schema: { tags: ["admin"], params: idParam, response: { 200: ok } } }, async (req) => {
    const a = await deleteAttribute(req.params.id);
    await audit({ ...who(req), action: "attribute.delete", entity: "Attribute", entityId: a.id, summary: `Deleted attribute "${a.name}" (${a._count.productAttributes} product values)` });
    revalidateFrontend([TAGS.filters, TAGS.products]);
    return { ok: true as const };
  });

  // ── Brands ──────────────────────────────────────────────────────────────────
  app.get("/admin/brands", { preHandler: requirePermission("products:read"), schema: { tags: ["admin"] } }, async () => ({ items: await listBrands() }));

  app.post("/admin/brands", { preHandler: requirePermission("products:write"), schema: { tags: ["admin"], body: brandInputSchema, response: { 201: saved } } }, async (req, reply) => {
    const r = await saveBrand(null, req.body);
    await audit({ ...who(req), action: "brand.create", entity: "Brand", entityId: r.id, summary: `Created brand "${req.body.name}"` });
    revalidateFrontend([TAGS.brands, TAGS.products, TAGS.pages]);
    return reply.code(201).send(r);
  });

  app.put("/admin/brands/:id", { preHandler: requirePermission("products:write"), schema: { tags: ["admin"], params: idParam, body: brandInputSchema, response: { 200: saved } } }, async (req) => {
    const r = await saveBrand(req.params.id, req.body);
    await audit({ ...who(req), action: "brand.update", entity: "Brand", entityId: r.id, summary: `Updated brand "${req.body.name}"`, after: { ...req.body } });
    revalidateFrontend([TAGS.brands, TAGS.products, TAGS.pages]);
    return r;
  });

  app.delete("/admin/brands/:id", { preHandler: requirePermission("products:write"), schema: { tags: ["admin"], params: idParam, response: { 200: ok } } }, async (req) => {
    const b = await deleteBrand(req.params.id);
    await audit({ ...who(req), action: "brand.delete", entity: "Brand", entityId: b.id, summary: `Deleted brand "${b.name}" (${b._count.products} products kept without a brand)` });
    revalidateFrontend([TAGS.brands, TAGS.products, TAGS.pages]);
    return { ok: true as const };
  });

  // ── Media ───────────────────────────────────────────────────────────────────
  app.get("/admin/media", { preHandler: requirePermission("products:read"), schema: { tags: ["admin"], querystring: mediaListQuery } }, async (req) => listMedia(req.query));

  app.post(
    "/admin/media",
    {
      preHandler: requirePermission("media:write"),
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: { tags: ["admin"], consumes: ["multipart/form-data"], response: { 201: mediaDto.extend({ warning: z.string().nullable() }) } },
    },
    async (req, reply) => {
      const file = await req.file().catch(() => undefined);
      if (!file) throw new HttpError(400, "no_file", "Choose an image to upload.");
      const field = (name: string) => {
        const f = file.fields[name];
        const one = Array.isArray(f) ? f[0] : f;
        return one && "value" in one ? String(one.value) : "";
      };
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch {
        throw new HttpError(413, "too_large", "That image is over 8 MB. Choose a smaller one.");
      }
      const m = await uploadMedia({ buffer, mimetype: file.mimetype, alt: field("alt"), isDecorative: field("decorative") === "true", folder: field("folder") || "general", uploadedById: req.authUser!.id });
      await audit({ ...who(req), action: "media.upload", entity: "MediaAsset", entityId: m.id, summary: `Uploaded image${m.alt ? ` "${m.alt}"` : ""}` });
      return reply.code(201).send(m);
    },
  );

  app.patch("/admin/media/:id", { preHandler: requirePermission("media:write"), schema: { tags: ["admin"], params: idParam, body: mediaMetaSchema, response: { 200: mediaDto } } }, async (req) => {
    const m = await updateMediaMeta(req.params.id, req.body);
    await audit({ ...who(req), action: "media.update", entity: "MediaAsset", entityId: m.id, summary: "Updated image alt text" });
    revalidateFrontend([TAGS.products, TAGS.pages, TAGS.banners]);
    return m;
  });
};
