import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  bannerInputSchema,
  BUTTON_RADII,
  COLOR_TOKENS,
  CONTRAST_PAIRS,
  DARK_COLORS,
  draftInputSchema,
  FONT_LABELS,
  LIGHT_COLORS,
  menuInputSchema,
  menuKeySchema,
  pageMetaSchema,
  RADIUS_SCALES,
  TAGS,
} from "../core";
import { builderReference, discardDraft, listPages, previewPage, publishPage, readPageForBuilder, saveDraft, updatePageMeta } from "../admin/pages";
import { deleteBanner, deleteMedia, listBanners, listMenus, mediaUsage, readMenuForEdit, saveBanner, saveMenu } from "../admin/storefront";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { notFound } from "../lib/errors";
import { revalidateFrontend } from "../lib/revalidate";
import { requirePermission } from "../plugins/auth";

const idParam = z.object({ id: z.string().regex(/^[a-z0-9]{10,40}$/i) });
const ok = z.object({ ok: z.literal(true) });
const who = (req: FastifyRequest) => ({ actorId: req.authUser?.id ?? null, ip: req.ip });

/** Admin: homepage/page builder, banners, navigation menus, media library, theme metadata. */
export const adminStorefrontRoutes: FastifyPluginAsyncZod = async (app) => {
  const storefront = requirePermission("storefront:write");

  // ── Pages & builder ────────────────────────────────────────────────────────
  app.get("/admin/pages", { preHandler: storefront, schema: { tags: ["admin"] } }, async () => ({ items: await listPages() }));

  app.get("/admin/pages/:id", { preHandler: storefront, schema: { tags: ["admin"], params: idParam } }, async (req) => {
    const p = await readPageForBuilder(req.params.id);
    if (!p) throw notFound("Page");
    return p;
  });

  /** Autosave target: stores the working copy without touching the live page. */
  app.put("/admin/pages/:id/draft", { preHandler: storefront, schema: { tags: ["admin"], params: idParam, body: draftInputSchema } }, async (req) =>
    saveDraft(req.params.id, req.body.sections, req.authUser?.id ?? null),
  );

  app.post("/admin/pages/:id/publish", { preHandler: storefront, schema: { tags: ["admin"], params: idParam } }, async (req) => {
    const r = await publishPage(req.params.id);
    if (r.changed) {
      await audit({ ...who(req), action: "page.publish", entity: "Page", entityId: req.params.id, summary: `Published “${r.title}” (${r.sectionCount} sections)` });
      revalidateFrontend([TAGS.page(r.slug), TAGS.pages]);
    }
    return { ok: true as const, changed: r.changed };
  });

  app.post("/admin/pages/:id/discard", { preHandler: storefront, schema: { tags: ["admin"], params: idParam, response: { 200: ok } } }, async (req) => {
    const p = await discardDraft(req.params.id);
    await audit({ ...who(req), action: "page.discard_draft", entity: "Page", entityId: p.id, summary: `Discarded draft of ${p.slug}` });
    return { ok: true as const };
  });

  app.put("/admin/pages/:id", { preHandler: storefront, schema: { tags: ["admin"], params: idParam, body: pageMetaSchema, response: { 200: ok } } }, async (req) => {
    const r = await updatePageMeta(req.params.id, req.body);
    await audit({ ...who(req), action: "page.update", entity: "Page", entityId: req.params.id, summary: `Updated “${req.body.title}” details`, before: r.before, after: req.body });
    revalidateFrontend([TAGS.page(r.slug), TAGS.pages]);
    return { ok: true as const };
  });

  app.get(
    "/admin/pages/:id/preview",
    {
      preHandler: storefront,
      schema: { tags: ["admin"], params: idParam, querystring: z.object({ source: z.enum(["draft", "published"]).default("draft"), at: z.iso.datetime({ offset: true }).optional() }) },
    },
    async (req) => {
      const r = await previewPage(req.params.id, req.query.source, req.query.at ? new Date(req.query.at) : new Date(), (m) => req.log.warn(m));
      if (!r) throw notFound("Page");
      return r;
    },
  );

  app.get("/admin/builder/reference", { preHandler: storefront, schema: { tags: ["admin"] } }, async () => builderReference());

  /** Product cards for ids picked in section forms (manual product lists). */
  app.get(
    "/admin/products/lookup",
    { preHandler: requirePermission("products:read"), schema: { tags: ["admin"], querystring: z.object({ ids: z.string().max(2000) }) } },
    async (req) => {
      const ids = req.query.ids.split(",").filter((x) => /^[a-z0-9]{10,40}$/i.test(x)).slice(0, 60);
      const rows = await prisma.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true, status: true, priceCents: true, images: { take: 1, orderBy: { position: "asc" }, select: { media: { select: { url: true } } } } },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      return {
        items: ids.flatMap((id) => {
          const r = byId.get(id);
          return r ? [{ id: r.id, title: r.title, status: r.status, priceCents: r.priceCents, imageUrl: r.images[0]?.media.url ?? null }] : [];
        }),
      };
    },
  );

  // ── Banners ───────────────────────────────────────────────────────────────
  app.get("/admin/banners", { preHandler: storefront, schema: { tags: ["admin"] } }, async () => ({ items: await listBanners() }));

  app.post("/admin/banners", { preHandler: storefront, schema: { tags: ["admin"], body: bannerInputSchema } }, async (req, reply) => {
    const { banner } = await saveBanner(null, req.body);
    await audit({ ...who(req), action: "banner.create", entity: "Banner", entityId: banner.id, summary: `Created banner “${banner.name}”`, after: req.body });
    revalidateFrontend([TAGS.banners]);
    return reply.code(201).send({ id: banner.id });
  });

  app.put("/admin/banners/:id", { preHandler: storefront, schema: { tags: ["admin"], params: idParam, body: bannerInputSchema } }, async (req) => {
    const { banner, before } = await saveBanner(req.params.id, req.body);
    await audit({ ...who(req), action: "banner.update", entity: "Banner", entityId: banner.id, summary: `Updated banner “${banner.name}”`, before: before as Record<string, unknown> | null, after: req.body });
    revalidateFrontend([TAGS.banners]);
    return { id: banner.id };
  });

  app.delete("/admin/banners/:id", { preHandler: storefront, schema: { tags: ["admin"], params: idParam, response: { 200: ok } } }, async (req) => {
    const b = await deleteBanner(req.params.id);
    await audit({ ...who(req), action: "banner.delete", entity: "Banner", entityId: b.id, summary: `Deleted banner “${b.name}”` });
    revalidateFrontend([TAGS.banners]);
    return { ok: true as const };
  });

  // ── Navigation ─────────────────────────────────────────────────────────────
  app.get("/admin/navigation", { preHandler: storefront, schema: { tags: ["admin"] } }, async () => ({ items: await listMenus() }));

  app.get("/admin/navigation/:key", { preHandler: storefront, schema: { tags: ["admin"], params: z.object({ key: menuKeySchema }) } }, async (req) => {
    const m = await readMenuForEdit(req.params.key);
    if (!m) throw notFound("Menu");
    return m;
  });

  app.put("/admin/navigation/:key", { preHandler: storefront, schema: { tags: ["admin"], params: z.object({ key: menuKeySchema }), body: menuInputSchema } }, async (req) => {
    const r = await saveMenu(req.params.key, req.body);
    await audit({ ...who(req), action: "navigation.update", entity: "NavigationMenu", entityId: req.params.key, summary: `Updated menu “${req.body.name}” (${r.count} items)` });
    revalidateFrontend([TAGS.navigation]);
    return { ok: true as const, count: r.count };
  });

  // ── Media library ──────────────────────────────────────────────────────────
  app.get("/admin/media/:id/usage", { preHandler: requirePermission("products:read"), schema: { tags: ["admin"], params: idParam } }, async (req) => ({ usedBy: await mediaUsage(req.params.id) }));

  app.delete("/admin/media/:id", { preHandler: requirePermission("media:write"), schema: { tags: ["admin"], params: idParam, response: { 200: ok } } }, async (req) => {
    const m = await deleteMedia(req.params.id);
    await audit({ ...who(req), action: "media.delete", entity: "MediaAsset", entityId: m.id, summary: `Deleted image “${m.alt || m.id}”` });
    return { ok: true as const };
  });

  // ── Theme editor metadata (defaults, contrast rules, font list) ────────────
  app.get("/admin/settings/theme/meta", { preHandler: requirePermission("theme:write"), schema: { tags: ["admin"] } }, async () => ({
    tokens: COLOR_TOKENS,
    defaults: { light: LIGHT_COLORS, dark: DARK_COLORS },
    pairs: CONTRAST_PAIRS,
    fonts: Object.entries(FONT_LABELS).map(([key, label]) => ({ key, label })),
    radiusScales: Object.keys(RADIUS_SCALES),
    buttonStyles: Object.keys(BUTTON_RADII),
  }));
};
