import { describe, expect, it } from "vitest";
import { safeParseSectionConfig, sectionInputSchema } from "../src/core/sections";

describe("section schemas", () => {
  it("validates a product carousel with defaults", () => {
    const r = safeParseSectionConfig("product-carousel", { source: { kind: "best-sellers" } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ limit: 12 });
  });
  it("rejects unknown section types", () => {
    expect(safeParseSectionConfig("marquee", {}).success).toBe(false);
  });
  it("enforces promo banner count per layout", () => {
    expect(safeParseSectionConfig("promo-banner", { layout: "split", bannerIds: ["a"] }).success).toBe(false);
    expect(safeParseSectionConfig("promo-banner", { layout: "split", bannerIds: ["a", "b"] }).success).toBe(true);
  });
  it("requires a timezone-qualified end date for countdowns", () => {
    const base = { source: { kind: "on-sale" } };
    expect(safeParseSectionConfig("deal-countdown", { ...base, endsAt: "2026-12-01T00:00:00Z" }).success).toBe(true);
    expect(safeParseSectionConfig("deal-countdown", { ...base, endsAt: "tomorrow" }).success).toBe(false);
  });
  it("parses a full section payload by type", () => {
    const r = sectionInputSchema.safeParse({ type: "newsletter", title: "Stay in the loop", config: {} });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.device).toBe("ALL");
  });
});
