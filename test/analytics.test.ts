import "dotenv/config";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { windowFor } from "../src/admin/analytics";
import { createPrisma } from "../src/db";

describe("analytics window", () => {
  it("covers N whole UTC days ending today, and the N days before", () => {
    const { from, prevFrom } = windowFor(7, new Date("2026-11-11T15:30:00Z"));
    expect(from.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(prevFrom.toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });
});

/*
 * Recording and counting against the dev database. These tests write rows, so
 * they only run when DATABASE_URL points at this machine — never a hosted
 * (production) database — and they delete what they wrote.
 */
const url = process.env.DATABASE_URL ?? "";
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const db = local ? createPrisma() : null;
const reachable = db ? await db.$queryRaw`SELECT 1`.then(() => true).catch(() => false) : false;
const tag = `test${randomBytes(8).toString("hex")}`;
afterAll(async () => {
  await db?.productEvent.deleteMany({ where: { visitorId: { startsWith: tag } } });
  await db?.$disconnect();
});

describe.skipIf(!reachable)("analytics events (local database)", async () => {
  const { recordEvents, recordView } = await import("../src/analytics/events");
  const { productAnalytics } = await import("../src/admin/analytics");
  const product = await db!.product.findFirstOrThrow({ where: { status: "ACTIVE" }, select: { id: true } });
  const member = await db!.user.findFirstOrThrow({ where: { role: "CUSTOMER" }, select: { id: true } });
  const guest = { userId: null, visitorId: `${tag}-guest`, staff: false };
  const shopper = { userId: member.id, visitorId: `${tag}-member`, staff: false };
  const staff = { userId: member.id, visitorId: `${tag}-staff`, staff: true };

  it("counts a visitor's repeat views within 30 minutes once", async () => {
    expect(await recordView(guest, product.id)).toBe(true);
    expect(await recordView(guest, product.id)).toBe(false);
    // After the window, it counts again.
    expect(await recordView(guest, product.id, undefined, new Date(Date.now() + 31 * 60_000))).toBe(true);
    await db!.productEvent.deleteMany({ where: { visitorId: guest.visitorId, createdAt: { gt: new Date() } } });
  });

  it("never records staff", async () => {
    expect(await recordView(staff, product.id)).toBe(false);
    await recordEvents(staff, [{ type: "ADD_TO_CART", productId: product.id }]);
    expect(await db!.productEvent.count({ where: { visitorId: staff.visitorId } })).toBe(0);
  });

  it("adds up views, visitors, carts and buyers, split by members and guests", async () => {
    const before = (await productAnalytics(product.id, 7)).product!;
    await recordView(shopper, product.id);
    await recordEvents(shopper, [{ type: "ADD_TO_CART", productId: product.id, quantity: 2 }]);
    await recordEvents(shopper, [{ type: "PURCHASE", productId: product.id, quantity: 2 }]);
    await recordEvents(guest, [{ type: "ADD_TO_CART", productId: product.id }, { type: "SHARE", productId: product.id }]);
    const after = (await productAnalytics(product.id, 7)).product!;

    expect(after.views - before.views).toBe(1); // the guest's view is from the first test
    expect(after.memberViews - before.memberViews).toBe(1);
    expect(after.carts - before.carts).toBe(3);
    expect(after.carters - before.carters).toBe(2);
    expect(after.buyers - before.buyers).toBe(1);
    expect(after.shares - before.shares).toBe(1);
  });
});
