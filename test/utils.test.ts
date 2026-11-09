import { describe, expect, it } from "vitest";
import { applyBps, discountPercent, formatMoney } from "../src/core/money";
import { slugify } from "../src/core/slug";
import { effectivePermissions, hasPermission } from "../src/core/auth";

describe("money", () => {
  it("formats cents", () => expect(formatMoney(129_99)).toBe("$129.99"));
  it("rounds discount percent down", () => {
    expect(discountPercent(7999, 9999)).toBe(20);
    expect(discountPercent(1000, 1000)).toBe(0);
    expect(discountPercent(1000, null)).toBe(0);
  });
  it("applies basis points", () => expect(applyBps(10_000, 1500)).toBe(1500));
});

describe("slugify", () => {
  it("normalizes text", () => {
    expect(slugify("  Café & Bar — Menu! ")).toBe("cafe-and-bar-menu");
    expect(slugify("Men's Shoes")).toBe("men-s-shoes");
  });
});

describe("permissions", () => {
  it("super admin has everything, admin lacks users:write", () => {
    expect(hasPermission({ role: "SUPER_ADMIN" }, "users:write")).toBe(true);
    expect(hasPermission({ role: "ADMIN" }, "users:write")).toBe(false);
    expect(hasPermission({ role: "ADMIN" }, "products:write")).toBe(true);
    expect(hasPermission({ role: "CUSTOMER" }, "dashboard:read")).toBe(false);
  });
  it("custom permissions replace role defaults", () => {
    expect(effectivePermissions("ADMIN", ["orders:read"])).toEqual(["orders:read"]);
  });
});
