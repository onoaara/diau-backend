import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { promoJoin } from "../src/catalog/search";
import { effectivePrice } from "../src/core/pricing";
import { createPrisma } from "../src/db";

/**
 * The search SQL computes promotion prices for filtering and sorting. It must
 * agree with core/pricing.ts (used for display and checkout) on every product.
 * Runs against the dev database; skipped when it isn't reachable.
 */
const db = process.env.DATABASE_URL ? createPrisma() : null;
const reachable = db ? await db.$queryRaw`SELECT 1`.then(() => true).catch(() => false) : false;
afterAll(() => db?.$disconnect());

describe.skipIf(!reachable)("promotion pricing: SQL matches pricing.ts", () => {
  it("for every product in the catalog", async () => {
    const now = new Date();
    const rows = await db!.$queryRaw<Array<{ id: string; sql_price: number }>>`
      SELECT p.id, LEAST(p."priceCents", COALESCE(promo.price, p."priceCents"))::int AS sql_price
      FROM "Product" p ${promoJoin}`;
    const products = await db!.product.findMany({
      select: {
        id: true,
        priceCents: true,
        compareAtPriceCents: true,
        promotions: {
          where: { promotion: { isActive: true, startsAt: { lte: now }, endsAt: { gt: now } } },
          select: { specialPriceCents: true, promotion: { select: { id: true, discountType: true, value: true, endsAt: true } } },
        },
      },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    let promoted = 0;
    for (const row of rows) {
      const p = byId.get(row.id)!;
      const promos = p.promotions.map((x) => ({
        promotionId: x.promotion.id,
        discountType: x.promotion.discountType,
        value: x.promotion.value,
        specialPriceCents: x.specialPriceCents,
        endsAt: x.promotion.endsAt,
      }));
      if (promos.length) promoted++;
      expect(row.sql_price, `product ${row.id}`).toBe(effectivePrice(p, promos).priceCents);
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(promoted).toBeGreaterThan(0);
  });
});
