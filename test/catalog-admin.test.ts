import { describe, expect, it } from "vitest";
import {
  attributeInputSchema,
  categoryFiltersInputSchema,
  createsCycle,
  mediaMetaSchema,
  productInputSchema,
  tiptapText,
  variantCombinations,
} from "../src/core/catalog-admin";

const ID = "cmw6yjmje031r1gljap27akfb";
const base = {
  title: "Linen shirt",
  status: "DRAFT" as const,
  condition: "NEW" as const,
  categoryId: ID,
  brandId: null,
  tags: [],
  description: null,
  priceCents: 2500,
  compareAtPriceCents: null,
  sku: null,
  stock: 3,
  trackInventory: true,
  lowStockThreshold: 2,
  freeShipping: false,
  location: null,
  weightGrams: null,
  shippingInfo: null,
  returnsInfo: null,
  seoTitle: null,
  seoDescription: null,
  videoUrl: null,
  publishAt: null,
  unpublishAt: null,
  images: [],
  options: [],
  variants: [],
  attributes: [],
};
const paths = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) => (r.error?.issues ?? []).map((i) => i.path.join("."));

describe("productInputSchema", () => {
  it("accepts a simple product", () => expect(productInputSchema.safeParse(base).success).toBe(true));
  it("rejects a compare-at price that isn't higher", () => {
    expect(paths(productInputSchema.safeParse({ ...base, compareAtPriceCents: 2500 }))).toContain("compareAtPriceCents");
  });
  it("requires variants to match options, without duplicates", () => {
    const options = [{ name: "Size", values: [{ value: "S" }, { value: "M" }] }];
    const ok = productInputSchema.safeParse({
      ...base,
      options,
      variants: [
        { options: { Size: "S" }, priceCents: null, compareAtPriceCents: null, stock: 1, sku: null },
        { options: { Size: "M" }, priceCents: 3000, compareAtPriceCents: null, stock: 1, sku: null },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = productInputSchema.safeParse({
      ...base,
      options,
      variants: [
        { options: { Size: "XL" }, priceCents: null, compareAtPriceCents: null, stock: 1, sku: null },
        { options: { Size: "S" }, priceCents: null, compareAtPriceCents: null, stock: 1, sku: null },
        { options: { Size: "S" }, priceCents: null, compareAtPriceCents: null, stock: 1, sku: null },
      ],
    });
    expect(paths(bad)).toEqual(expect.arrayContaining(["variants.0.options", "variants.2.options"]));
  });
  it("only allows https video links", () => {
    expect(paths(productInputSchema.safeParse({ ...base, videoUrl: "javascript:alert(1)" }))).toContain("videoUrl");
    expect(productInputSchema.safeParse({ ...base, videoUrl: "https://cdn.example.com/v.mp4" }).success).toBe(true);
  });
  it("checks schedule order", () => {
    expect(paths(productInputSchema.safeParse({ ...base, publishAt: "2026-12-02", unpublishAt: "2026-12-01" }))).toContain("unpublishAt");
  });
});

describe("helpers", () => {
  it("generates every option combination", () => {
    expect(variantCombinations([{ name: "Size", values: [{ value: "S" }, { value: "M" }] }, { name: "Color", values: [{ value: "Red" }] }])).toEqual([
      { Size: "S", Color: "Red" },
      { Size: "M", Color: "Red" },
    ]);
    expect(variantCombinations([])).toEqual([]);
  });
  it("extracts description text", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Soft " }, { type: "text", text: "linen" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Machine wash" }] }] }] },
      ],
    };
    expect(tiptapText(doc)).toBe("Soft linen\nMachine wash");
  });
  it("detects category cycles", () => {
    expect(createsCycle([{ id: "a", parentId: null }, { id: "b", parentId: "a" }])).toBe(false);
    expect(createsCycle([{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }])).toBe(true);
  });
  it("rejects duplicate filters", () => {
    const f = { builtIn: "PRICE" as const, attributeId: null, label: null, displayType: "SLIDER" as const, isCollapsed: false, inheritToChildren: true };
    expect(categoryFiltersInputSchema.safeParse({ filters: [f, f] }).success).toBe(false);
  });
  it("requires values for list attributes only", () => {
    expect(attributeInputSchema.safeParse({ name: "Color", type: "COLOR", unit: null, isFilterable: true, showInSpecs: true, values: [] }).success).toBe(false);
    expect(attributeInputSchema.safeParse({ name: "Weight", type: "NUMBER", unit: "g", isFilterable: false, showInSpecs: true, values: [] }).success).toBe(true);
  });
  it("requires alt text unless decorative", () => {
    expect(mediaMetaSchema.safeParse({ alt: "", isDecorative: false }).success).toBe(false);
    expect(mediaMetaSchema.safeParse({ alt: "", isDecorative: true }).success).toBe(true);
  });
});
