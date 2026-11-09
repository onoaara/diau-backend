import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { liveProductWhere } from "../catalog/product-feed";
import { prisma } from "../db";

/** One sitemap file holds at most 50,000 URLs; leave room for pages and categories. */
export const SITEMAP_PRODUCT_LIMIT = 45_000;

const entry = z.object({ slug: z.string(), updatedAt: z.string() });
export const sitemapResponse = z.object({
  products: z.array(entry),
  categories: z.array(entry),
  pages: z.array(entry),
});
export type SitemapDto = z.infer<typeof sitemapResponse>;

/**
 * Everything a search engine may index, with last-modified dates. Uses the
 * same visibility rules as the storefront: live products in a visible
 * category, visible categories, and published pages other than the homepage.
 */
export async function readSitemap(now = new Date()): Promise<SitemapDto> {
  const iso = (r: { slug: string; updatedAt: Date }) => ({ slug: r.slug, updatedAt: r.updatedAt.toISOString() });
  const [products, categories, pages] = await Promise.all([
    prisma.product.findMany({
      where: { ...liveProductWhere(now), category: { isVisible: true } },
      orderBy: { updatedAt: "desc" },
      take: SITEMAP_PRODUCT_LIMIT,
      select: { slug: true, updatedAt: true },
    }),
    prisma.category.findMany({ where: { isVisible: true }, orderBy: { position: "asc" }, select: { slug: true, updatedAt: true } }),
    prisma.page.findMany({ where: { status: "PUBLISHED", slug: { not: "home" } }, orderBy: { slug: "asc" }, select: { slug: true, updatedAt: true } }),
  ]);
  return { products: products.map(iso), categories: categories.map(iso), pages: pages.map(iso) };
}

export const sitemapRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/sitemap", { schema: { tags: ["storefront"], response: { 200: sitemapResponse } } }, () => readSitemap());
};
