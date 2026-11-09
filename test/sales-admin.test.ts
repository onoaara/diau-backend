import { describe, expect, it } from "vitest";
import { canTransition, contentPageInputSchema, couponInputSchema, orderStatusInputSchema, promotionInputSchema, refundOutcome } from "../src/core";

describe("order status transitions", () => {
  it("follows the fulfilment flow", () => {
    expect(canTransition("PENDING", "CONFIRMED")).toBe(true);
    expect(canTransition("CONFIRMED", "SHIPPED")).toBe(true);
    expect(canTransition("SHIPPED", "DELIVERED")).toBe(true);
  });
  it("can't cancel shipped orders or reopen final ones", () => {
    expect(canTransition("SHIPPED", "CANCELLED")).toBe(false);
    expect(canTransition("CANCELLED", "PENDING")).toBe(false);
    expect(canTransition("DELIVERED", "PROCESSING")).toBe(false);
  });
  it("only reaches REFUNDED through a refund", () => {
    expect(orderStatusInputSchema.safeParse({ status: "REFUNDED" }).success).toBe(false);
  });
});

describe("refunds", () => {
  const paid = { status: "PAID", amountCents: 10_000, refundedAmountCents: 0 };
  it("partial then full", () => {
    expect(refundOutcome(paid, 2500)).toEqual({ ok: true, refunded: 2500, status: "PARTIALLY_REFUNDED", full: false });
    expect(refundOutcome({ ...paid, status: "PARTIALLY_REFUNDED", refundedAmountCents: 2500 }, 7500)).toEqual({ ok: true, refunded: 10_000, status: "REFUNDED", full: true });
  });
  it("never more than what's left, and only on paid payments", () => {
    expect(refundOutcome({ ...paid, refundedAmountCents: 9000 }, 2000).ok).toBe(false);
    expect(refundOutcome({ ...paid, status: "PENDING" }, 100).ok).toBe(false);
  });
});

describe("coupons", () => {
  const base = { code: " spring 10 ", description: null, type: "PERCENT", value: 1000, minSubtotalCents: null, maxUses: null, perCustomerLimit: null, scope: "ALL", categoryIds: [], productIds: [], startsAt: null, endsAt: null, isActive: true };
  it("normalizes codes", () => {
    expect(couponInputSchema.parse(base).code).toBe("SPRING10");
  });
  it("bounds percentages and needs targets for scoped coupons", () => {
    expect(couponInputSchema.safeParse({ ...base, value: 9500 }).success).toBe(false);
    expect(couponInputSchema.safeParse({ ...base, scope: "PRODUCTS" }).success).toBe(false);
    expect(couponInputSchema.safeParse({ ...base, type: "FREE_SHIPPING", value: 0 }).success).toBe(true);
  });
});

describe("promotions", () => {
  const base = { name: "Spring", type: "SALE", discountType: "PERCENT", value: 2000, startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-08T00:00:00Z", isActive: true, products: [{ productId: "cprod0000000001", specialPriceCents: null }] };
  it("accepts a valid promotion", () => expect(promotionInputSchema.safeParse(base).success).toBe(true));
  it("rejects bad windows, duplicates and huge discounts", () => {
    expect(promotionInputSchema.safeParse({ ...base, endsAt: base.startsAt }).success).toBe(false);
    expect(promotionInputSchema.safeParse({ ...base, products: [...base.products, ...base.products] }).success).toBe(false);
    expect(promotionInputSchema.safeParse({ ...base, value: 9500 }).success).toBe(false);
  });
});

describe("content pages", () => {
  it("keeps store routes reserved", () => {
    const page = { title: "Cart", kind: "CONTENT", status: "DRAFT", content: null };
    expect(contentPageInputSchema.safeParse({ ...page, slug: "cart" }).success).toBe(false);
    expect(contentPageInputSchema.safeParse({ ...page, slug: "shipping-policy" }).success).toBe(true);
  });
});
