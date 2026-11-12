import { describe, expect, it } from "vitest";
import { centsStep, computeTotals, convertCents, resolveCurrency, siteConfigSchema } from "../src/core";

const site = siteConfigSchema.parse({ currency: "USD", currencies: [{ code: "GBP", rate: 0.79 }, { code: "JPY", rate: 151.234 }] });

describe("resolveCurrency", () => {
  it("uses an offered currency and its rate", () => {
    expect(resolveCurrency(site, "gbp")).toEqual({ code: "GBP", rate: 0.79, base: "USD" });
  });
  it("falls back to the base for missing, unknown or base codes", () => {
    for (const code of [null, undefined, "", "EUR", "USD", "nope"]) expect(resolveCurrency(site, code)).toEqual({ code: "USD", rate: 1, base: "USD" });
  });
});

describe("convertCents", () => {
  const gbp = resolveCurrency(site, "GBP");
  const jpy = resolveCurrency(site, "JPY");
  it("rounds to the nearest minor unit", () => {
    expect(convertCents(1999, gbp)).toBe(1579); // 15.7921 -> 15.79
    expect(convertCents(1999, resolveCurrency(site, "USD"))).toBe(1999);
  });
  it("rounds zero-decimal currencies to whole units", () => {
    expect(centsStep("JPY")).toBe(100);
    expect(convertCents(1999, jpy)).toBe(302_300); // ¥3,023.17 -> ¥3,023
  });
});

describe("computeTotals step", () => {
  it("rounds percent discounts and tax to the currency's minor unit", () => {
    const t = computeTotals({
      lines: [{ productId: "p", categoryId: "c", unitPriceCents: 302_300, quantity: 1, freeShipping: false }],
      coupon: { code: "TEN", type: "PERCENT", value: 1000, minSubtotalCents: null, scope: "ALL", categoryIds: [], productIds: [] },
      shippingCents: 0,
      tax: { rateBps: 825, includeShipping: false },
      step: centsStep("JPY"),
    });
    expect(t.discountCents % 100).toBe(0);
    expect(t.taxCents % 100).toBe(0);
    expect(t.totalCents % 100).toBe(0);
  });
});

describe("site currencies", () => {
  it("rejects duplicate codes and non-positive rates", () => {
    expect(siteConfigSchema.safeParse({ currencies: [{ code: "GBP", rate: 1 }, { code: "GBP", rate: 2 }] }).success).toBe(false);
    expect(siteConfigSchema.safeParse({ currencies: [{ code: "GBP", rate: 0 }] }).success).toBe(false);
  });
});
