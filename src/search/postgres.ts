import { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { escapeLike, toPrefixTsQuery } from "./query";
import type { CategorySuggestion, ProductSuggestion, SearchProvider, SuggestQuery } from "./types";

/** SQL condition for products shoppers may see right now (status + schedule). */
export const liveProductSql = Prisma.sql`
  p."status" = 'ACTIVE'
  AND (p."publishAt" IS NULL OR p."publishAt" <= now())
  AND (p."unpublishAt" IS NULL OR p."unpublishAt" > now())`;

/** Ids of a visible category and all of its visible descendants. */
export async function categoryScopeIds(slug: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE scope AS (
      SELECT id FROM "Category" WHERE slug = ${slug} AND "isVisible"
      UNION ALL
      SELECT c.id FROM "Category" c JOIN scope s ON c."parentId" = s.id WHERE c."isVisible"
    )
    SELECT id FROM scope`;
  return rows.map((r) => r.id);
}

type ProductRow = {
  id: string;
  title: string;
  slug: string;
  priceCents: number;
  compareAtPriceCents: number | null;
  imageUrl: string | null;
  imageAlt: string | null;
};

export const postgresSearch: SearchProvider = {
  async suggest({ q, category, limit = 6 }: SuggestQuery) {
    const tsquery = toPrefixTsQuery(q);
    if (!tsquery) return { products: [], categories: [] };
    const like = `%${escapeLike(q.trim())}%`;

    const scope = category ? await categoryScopeIds(category) : null;
    if (scope && scope.length === 0) return { products: [], categories: [] };
    const scopeSql = scope ? Prisma.sql`AND p."categoryId" = ANY(${scope}::text[])` : Prisma.empty;

    const [productRows, categoryRows] = await Promise.all([
      prisma.$queryRaw<ProductRow[]>`
        SELECT p.id, p.title, p.slug, p."priceCents", p."compareAtPriceCents",
               img.url AS "imageUrl", img.alt AS "imageAlt"
        FROM "Product" p
        LEFT JOIN LATERAL (
          SELECT m.url, COALESCE(pi.alt, m.alt) AS alt
          FROM "ProductImage" pi JOIN "MediaAsset" m ON m.id = pi."mediaId"
          WHERE pi."productId" = p.id
          ORDER BY pi.position
          LIMIT 1
        ) img ON true
        WHERE ${liveProductSql}
          AND (p."searchVector" @@ to_tsquery('simple', ${tsquery}) OR p.title ILIKE ${like})
          ${scopeSql}
        ORDER BY ts_rank(p."searchVector", to_tsquery('simple', ${tsquery})) DESC,
                 similarity(p.title, ${q}) DESC,
                 p."soldCount" DESC
        LIMIT ${limit}`,
      prisma.$queryRaw<CategorySuggestion[]>`
        SELECT c.id, c.name, c.slug, parent.name AS "parentName"
        FROM "Category" c
        LEFT JOIN "Category" parent ON parent.id = c."parentId"
        WHERE c."isVisible" AND c.name ILIKE ${like}
          ${scope ? Prisma.sql`AND c.id = ANY(${scope}::text[])` : Prisma.empty}
        ORDER BY (c.name ILIKE ${`${escapeLike(q.trim())}%`}) DESC, c.position
        LIMIT 4`,
    ]);

    const products: ProductSuggestion[] = productRows.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      priceCents: r.priceCents,
      compareAtPriceCents: r.compareAtPriceCents,
      image: r.imageUrl ? { url: r.imageUrl, alt: r.imageAlt ?? "" } : null,
    }));
    return { products, categories: categoryRows };
  },
};
