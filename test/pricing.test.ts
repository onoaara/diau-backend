import { describe, expect, it } from "vitest";
import { effectivePrice, type PromotionDiscount } from "../src/core/pricing";
import { sanitizeRichText } from "../src/lib/sanitize";

const ends = new Date("2030-01-01T00:00:00Z");
const promo = (p: Partial<PromotionDiscount>): PromotionDiscount => ({
  promotionId: "p1",
  discountType: "PERCENT",
  value: 1500,
  specialPriceCents: null,
  endsAt: ends,
  ...p,
});

describe("effectivePrice", () => {
  it("shows a genuine compare-at price without promotions", () => {
    expect(effectivePrice({ priceCents: 1299, compareAtPriceCents: 1499 }, [])).toMatchObject({ priceCents: 1299, compareAtPriceCents: 1499, promotion: null });
  });
  it("hides a compare-at price that isn't higher", () => {
    expect(effectivePrice({ priceCents: 1299, compareAtPriceCents: 999 }, []).compareAtPriceCents).toBeNull();
  });
  it("applies a percent promotion and shows the regular price as 'was'", () => {
    const r = effectivePrice({ priceCents: 10000, compareAtPriceCents: 15000 }, [promo({})]);
    expect(r).toMatchObject({ priceCents: 8500, compareAtPriceCents: 10000, promotion: { id: "p1" } });
  });
  it("picks the lowest of several promotions", () => {
    const r = effectivePrice({ priceCents: 10000, compareAtPriceCents: null }, [
      promo({ promotionId: "a", value: 1000 }),
      promo({ promotionId: "b", discountType: "FIXED", value: 2500 }),
      promo({ promotionId: "c", specialPriceCents: 9000 }),
    ]);
    expect(r).toMatchObject({ priceCents: 7500, promotion: { id: "b" } });
  });
  it("never goes below zero or above the base price", () => {
    expect(effectivePrice({ priceCents: 1000, compareAtPriceCents: null }, [promo({ discountType: "FIXED", value: 5000 })]).priceCents).toBe(0);
    expect(effectivePrice({ priceCents: 1000, compareAtPriceCents: null }, [promo({ specialPriceCents: 1200 })])).toMatchObject({ priceCents: 1000, promotion: null });
  });
  it("flags free-shipping promotions without changing the price", () => {
    expect(effectivePrice({ priceCents: 1000, compareAtPriceCents: null }, [promo({ discountType: "FREE_SHIPPING", value: 0 })])).toMatchObject({ priceCents: 1000, freeShippingPromo: true, promotion: null });
  });
});

describe("sanitizeRichText", () => {
  it("removes scripts, event handlers and unsafe links", () => {
    const out = sanitizeRichText('<p onclick="x()">Hi<script>alert(1)</script> <a href="javascript:alert(1)">bad</a> <img src=x onerror=alert(1)></p>');
    expect(out).toBe("<p>Hi bad </p>");
  });
  it("demotes h1 and opens external links safely", () => {
    expect(sanitizeRichText('<h1>T</h1><a href="https://example.com">x</a><a href="/faq">y</a>')).toBe(
      '<h2>T</h2><a href="https://example.com/" target="_blank" rel="noopener noreferrer">x</a><a href="/faq">y</a>',
    );
  });
});
