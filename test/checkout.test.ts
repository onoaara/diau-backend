import { describe, expect, it } from "vitest";
import { computeTotals, formatOrderNumber, parseOrderNumber, rateAvailable, shippingFor, type CouponRule, type TotalsLine } from "../src/core/checkout";

const line = (p: Partial<TotalsLine> = {}): TotalsLine => ({ productId: "p1", categoryId: "c1", unitPriceCents: 2000, quantity: 2, freeShipping: false, ...p });
const coupon = (c: Partial<CouponRule>): CouponRule => ({ code: "X", type: "PERCENT", value: 1000, minSubtotalCents: null, scope: "ALL", categoryIds: [], productIds: [], ...c });
const standard = { priceCents: 599, freeOverCents: 5000, minSubtotalCents: null };

describe("shipping", () => {
  it("charges the rate below the free threshold and nothing above it", () => {
    expect(shippingFor(standard, [line()], 4000, true)).toBe(599);
    expect(shippingFor(standard, [line()], 5000, true)).toBe(0);
  });
  it("is free on the cheapest rate when every item ships free, not on faster ones", () => {
    const free = [line({ freeShipping: true })];
    expect(shippingFor(standard, free, 100, true)).toBe(0);
    expect(shippingFor({ priceCents: 1499, freeOverCents: null, minSubtotalCents: null }, free, 100, false)).toBe(1499);
  });
  it("hides rates below their minimum subtotal", () => {
    expect(rateAvailable({ priceCents: 0, freeOverCents: null, minSubtotalCents: 2500 }, 2000)).toBe(false);
  });
});

describe("totals", () => {
  it("adds subtotal, shipping and tax", () => {
    const t = computeTotals({ lines: [line()], coupon: null, shippingCents: 599, tax: { rateBps: 725, includeShipping: false } });
    expect(t).toMatchObject({ subtotalCents: 4000, discountCents: 0, shippingCents: 599, taxCents: 290, totalCents: 4889 });
  });
  it("applies percent and fixed coupons before tax", () => {
    expect(computeTotals({ lines: [line()], coupon: coupon({}), shippingCents: 0, tax: { rateBps: 1000, includeShipping: false } })).toMatchObject({
      discountCents: 400,
      taxCents: 360,
      totalCents: 3960,
    });
    expect(computeTotals({ lines: [line()], coupon: coupon({ type: "FIXED", value: 10_000 }), shippingCents: 0, tax: null }).discountCents).toBe(4000);
  });
  it("free-shipping coupons zero the shipping", () => {
    expect(computeTotals({ lines: [line()], coupon: coupon({ type: "FREE_SHIPPING", value: 0 }), shippingCents: 1499, tax: null })).toMatchObject({ shippingCents: 0, totalCents: 4000 });
  });
  it("explains coupons that don't apply", () => {
    const short = computeTotals({ lines: [line()], coupon: coupon({ minSubtotalCents: 15_000 }), shippingCents: 0, tax: null });
    expect(short.coupon).toMatchObject({ applied: false });
    expect(short.discountCents).toBe(0);
    const scoped = computeTotals({ lines: [line()], coupon: coupon({ scope: "CATEGORIES", categoryIds: ["other"] }), shippingCents: 0, tax: null });
    expect(scoped.coupon?.message).toMatch(/doesn't apply/);
  });
  it("limits scoped discounts to eligible lines", () => {
    const t = computeTotals({
      lines: [line(), line({ productId: "p2", categoryId: "c2", unitPriceCents: 1000, quantity: 1 })],
      coupon: coupon({ scope: "PRODUCTS", productIds: ["p2"], value: 5000 }),
      shippingCents: 0,
      tax: null,
    });
    expect(t.discountCents).toBe(500);
  });
  it("taxes shipping when the rate says so", () => {
    expect(computeTotals({ lines: [line()], coupon: null, shippingCents: 1000, tax: { rateBps: 1000, includeShipping: true } }).taxCents).toBe(500);
  });
});

describe("order numbers", () => {
  it("round-trips", () => {
    expect(formatOrderNumber(49)).toBe("DIA-000049");
    expect(parseOrderNumber("dia-000049")).toBe(49);
    expect(parseOrderNumber("49")).toBeNull();
  });
});
