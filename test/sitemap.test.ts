import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { createPrisma } from "../src/db";

/**
 * sitemap.xml must only list what shoppers can open. Checks the live query
 * against the dev database (skipped when it isn't reachable).
 */
const db = process.env.DATABASE_URL ? createPrisma() : null;
const reachable = db ? await db.$queryRaw`SELECT 1`.then(() => true).catch(() => false) : false;
afterAll(() => db?.$disconnect());

describe.skipIf(!reachable)("sitemap", async () => {
  const { readSitemap } = await import("../src/routes/sitemap");
  const now = new Date();
  const map = await readSitemap(now);

  it("lists only live products in visible categories", async () => {
    const rows = await db!.product.findMany({
      where: { slug: { in: map.products.map((p) => p.slug) } },
      select: { status: true, publishAt: true, unpublishAt: true, category: { select: { isVisible: true } } },
    });
    expect(rows).toHaveLength(map.products.length);
    for (const r of rows) {
      expect(r.status).toBe("ACTIVE");
      expect(r.category.isVisible).toBe(true);
      expect(!r.publishAt || r.publishAt <= now).toBe(true);
      expect(!r.unpublishAt || r.unpublishAt > now).toBe(true);
    }
  });

  it("includes every live product", async () => {
    const live = await db!.product.count({
      where: {
        status: "ACTIVE",
        category: { isVisible: true },
        AND: [{ OR: [{ publishAt: null }, { publishAt: { lte: now } }] }, { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] }],
      },
    });
    expect(map.products.length).toBe(Math.min(live, 45_000));
  });

  it("lists published pages except the homepage, and visible categories", async () => {
    expect(map.pages.some((p) => p.slug === "home")).toBe(false);
    const pages = await db!.page.findMany({ where: { slug: { in: map.pages.map((p) => p.slug) } }, select: { status: true } });
    expect(pages.every((p) => p.status === "PUBLISHED")).toBe(true);
    const hidden = await db!.category.count({ where: { slug: { in: map.categories.map((c) => c.slug) }, isVisible: false } });
    expect(hidden).toBe(0);
  });

  it("dates are ISO strings", () => {
    for (const e of [...map.products, ...map.categories, ...map.pages]) expect(new Date(e.updatedAt).toISOString()).toBe(e.updatedAt);
  });
});
