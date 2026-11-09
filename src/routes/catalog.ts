import multipart from "@fastify/multipart";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isSortKey, SORT_OPTIONS } from "../core";
import { productCardDto } from "../catalog/product-feed";
import { searchCatalog } from "../catalog/search";
import { HttpError, notFound } from "../lib/errors";
import { mediaDtoSchema } from "../lib/media";
import { imageSearch } from "../search/image-index";
import { readSite } from "./settings";

export const IMAGE_UPLOAD = { maxBytes: 8 * 1024 * 1024, types: ["image/jpeg", "image/png", "image/webp"] } as const;

const facetDto = z.object({
  key: z.string(),
  param: z.string(),
  label: z.string(),
  display: z.enum(["checkbox", "swatch", "slider", "toggle", "dropdown", "radio"]),
  collapsed: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string(), count: z.number().int(), selected: z.boolean(), hex: z.string().nullable() })),
  range: z
    .object({
      min: z.number(),
      max: z.number(),
      from: z.number().nullable(),
      to: z.number().nullable(),
      unit: z.string().nullable(),
      step: z.number(),
      currency: z.boolean(),
    })
    .nullable(),
  active: z.boolean(),
});

const searchResponse = z.object({
  query: z.object({
    q: z.string().nullable(),
    suggestion: z.string().nullable(),
    image: z.object({ token: z.string(), expired: z.boolean() }).nullable(),
  }),
  tag: z.object({ slug: z.string(), name: z.string() }).nullable(),
  category: z
    .object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      description: z.string().nullable(),
      seoTitle: z.string().nullable(),
      seoDescription: z.string().nullable(),
      banner: mediaDtoSchema.nullable(),
      breadcrumbs: z.array(z.object({ name: z.string(), slug: z.string() })),
    })
    .nullable(),
  subcategories: z.array(z.object({ name: z.string(), slug: z.string(), count: z.number().int() })),
  facets: z.array(facetDto),
  chips: z.array(z.object({ param: z.string(), value: z.string().nullable(), label: z.string() })),
  sort: z.enum(SORT_OPTIONS.map((o) => o.value) as [string, ...string[]]),
  sortOptions: z.array(z.object({ value: z.string(), label: z.string() })),
  items: z.array(productCardDto),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  pageCount: z.number().int(),
});

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export const catalogRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(multipart, { limits: { fileSize: IMAGE_UPLOAD.maxBytes, files: 1, fields: 0, parts: 1 } });

  /**
   * Results for category pages (`mode=category&category=<slug>`) and search
   * (`mode=search`). Every other parameter is read as a filter (see core/search-params.ts).
   */
  app.get(
    "/catalog/search",
    {
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
      schema: {
        tags: ["storefront"],
        querystring: z
          .record(z.string().max(60), z.union([z.string().max(1000), z.array(z.string().max(1000))]))
          .refine((r) => Object.keys(r).length <= 40, "Too many parameters"),
        response: { 200: searchResponse },
      },
    },
    async (req) => {
      const raw = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, first(v) ?? ""]));
      const mode = raw.mode === "category" ? "category" : "search";
      const page = Math.min(100, Math.max(1, Number.parseInt(raw.page ?? "1", 10) || 1));
      const slugish = (v: string | undefined) => (v && /^[a-z0-9-]{1,100}$/.test(v) ? v : null);
      if (mode === "category" && !slugish(raw.category)) throw notFound("Category");

      const site = await readSite();
      const result = await searchCatalog(
        {
          mode,
          q: raw.q?.trim() ? raw.q.slice(0, 200) : null,
          categorySlug: slugish(raw.category),
          tag: slugish(raw.tag),
          image: raw.image && /^[a-z0-9]{10,40}$/i.test(raw.image) ? raw.image : null,
          sort: isSortKey(raw.sort) ? raw.sort : "best",
          page,
          pageSize: 24,
          params: raw,
        },
        { currency: site.currency, locale: site.locale },
      );
      if (result.notFound) throw notFound("Category");
      const { notFound: _nf, ...body } = result;
      return body;
    },
  );

  /** Search by photo: stores the photo's visual signature (not the photo) and returns a results token. */
  app.post(
    "/search/image",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["storefront"], consumes: ["multipart/form-data"], response: { 201: z.object({ token: z.string() }) } },
    },
    async (req, reply) => {
      const file = await req.file().catch(() => undefined);
      if (!file) throw new HttpError(400, "no_file", "Choose a photo to search with.");
      if (!(IMAGE_UPLOAD.types as readonly string[]).includes(file.mimetype)) {
        throw new HttpError(415, "unsupported_type", "Use a JPG, PNG or WebP photo.");
      }
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch {
        throw new HttpError(413, "too_large", "That photo is over 8 MB. Choose a smaller one.");
      }
      let token: string;
      try {
        token = await imageSearch.createQuery(buffer);
      } catch {
        throw new HttpError(400, "unreadable_image", "We couldn't read that photo. Try a different one.");
      }
      return reply.code(201).send({ token });
    },
  );
};
