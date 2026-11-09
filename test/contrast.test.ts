import { describe, expect, it } from "vitest";
import { auditPalette, contrastRatio } from "../src/core/contrast";
import { DARK_COLORS, LIGHT_COLORS } from "../src/core/tokens";

describe("contrastRatio", () => {
  it("matches known WCAG values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
  });
  it("is symmetric", () => {
    expect(contrastRatio("#0E7C66", "#FFFFFF")).toBe(contrastRatio("#FFFFFF", "#0E7C66"));
  });
  it("rejects invalid hex", () => {
    expect(() => contrastRatio("red", "#FFFFFF")).toThrow();
  });
});

describe("default design tokens meet WCAG AA", () => {
  it("light palette", () => {
    expect(auditPalette(LIGHT_COLORS)).toEqual([]);
  });
  it("dark palette", () => {
    expect(auditPalette(DARK_COLORS)).toEqual([]);
  });
});
