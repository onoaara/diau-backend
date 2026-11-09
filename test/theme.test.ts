import { describe, expect, it } from "vitest";
import { buildThemeCss, DEFAULT_THEME, themeConfigInputSchema, themeConfigSchema } from "../src/core/theme";

describe("themeConfigSchema", () => {
  it("fills defaults from an empty object", () => {
    expect(themeConfigSchema.parse({})).toEqual(DEFAULT_THEME);
    expect(DEFAULT_THEME.fonts).toEqual({ display: "plus-jakarta-sans", body: "inter" });
  });
  it("rejects non-hex colors and unknown keys (no CSS injection)", () => {
    expect(themeConfigSchema.safeParse({ colors: { light: { accent: "red;}body{display:none" } } }).success).toBe(false);
    expect(themeConfigSchema.safeParse({ colors: { light: { "not-a-token": "#000000" } } }).success).toBe(false);
    expect(themeConfigSchema.safeParse({ extra: true }).success).toBe(false);
  });
  it("blocks low-contrast palettes on save", () => {
    const result = themeConfigInputSchema.safeParse({ colors: { light: { accent: "#7FE0C8" } } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/Primary button label/);
  });
});

describe("buildThemeCss", () => {
  it("emits only changed color tokens plus layout vars", () => {
    const css = buildThemeCss({ colors: { light: { accent: "#0B6E5A" } }, radiusScale: "round" });
    expect(css).toContain("--diau-accent:#0B6E5A;");
    expect(css).not.toContain("--diau-sale:");
    expect(css).toContain("--diau-radius-scale:1.4;");
    expect(css).toContain("--diau-font-body:var(--font-inter);");
  });
  it("falls back to defaults on invalid input", () => {
    expect(buildThemeCss({ colors: "nope" })).toBe(buildThemeCss({}));
  });
  it("applies the dark palette at :root for dark-only stores", () => {
    expect(buildThemeCss({ colorMode: "dark" })).toContain("color-scheme:dark");
  });
});
