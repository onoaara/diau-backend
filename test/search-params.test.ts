import { describe, expect, it } from "vitest";
import { attributeParam, formatRange, parseList, parseRange } from "../src/core/search-params";

describe("search URL params", () => {
  it("parses lists", () => {
    expect(parseList("apple, samsung,,apple")).toEqual(["apple", "samsung"]);
    expect(parseList(undefined)).toEqual([]);
  });
  it("parses ranges, open ends and reversed bounds", () => {
    expect(parseRange("20-100")).toEqual({ from: 20, to: 100 });
    expect(parseRange("20-")).toEqual({ from: 20, to: null });
    expect(parseRange("-5.5")).toEqual({ from: null, to: 5.5 });
    expect(parseRange("100-20")).toEqual({ from: 20, to: 100 });
    expect(parseRange("-")).toBeNull();
    expect(parseRange("abc")).toBeNull();
    expect(parseRange("1;drop")).toBeNull();
  });
  it("keeps attribute params from shadowing reserved names", () => {
    expect(attributeParam("color")).toBe("color");
    expect(attributeParam("price")).toBe("a-price");
  });
  it("formats ranges", () => {
    const f = (n: number) => `$${n}`;
    expect(formatRange(20, 100, f)).toBe("$20–$100");
    expect(formatRange(20, null, f)).toBe("$20 and up");
    expect(formatRange(null, 50, f)).toBe("Up to $50");
  });
});
