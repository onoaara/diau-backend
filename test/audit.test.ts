import { describe, expect, it } from "vitest";
import { stableStringify } from "../src/lib/stable-json";

describe("stableStringify", () => {
  it("ignores object key order (jsonb reorders keys)", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it("keeps array order significant", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});
