import { z } from "zod";
import { auditPalette, isHexColor } from "./contrast";
import {
  BUTTON_RADII,
  COLOR_TOKENS,
  DARK_COLORS,
  FONT_KEYS,
  LIGHT_COLORS,
  RADIUS_SCALES,
  type ColorScale,
  type ColorToken,
} from "./tokens";

const hex = z.string().refine(isHexColor, "Use a 6-digit hex color like #0E7C66");

/** Partial overrides: only tokens the admin changed are stored. */
const colorOverrides = z.partialRecord(z.enum(COLOR_TOKENS), hex);

export const themeConfigSchema = z
  .object({
    colors: z
      .object({ light: colorOverrides.default({}), dark: colorOverrides.default({}) })
      .default({ light: {}, dark: {} }),
    fonts: z
      .object({
        display: z.enum(FONT_KEYS).default("plus-jakarta-sans"),
        body: z.enum(FONT_KEYS).default("inter"),
      })
      .default({ display: "plus-jakarta-sans", body: "inter" }),
    radiusScale: z.enum(Object.keys(RADIUS_SCALES) as [keyof typeof RADIUS_SCALES]).default("default"),
    buttonStyle: z.enum(Object.keys(BUTTON_RADII) as [keyof typeof BUTTON_RADII]).default("rounded"),
    /** system = follow OS with user toggle; light = light only; dark = dark only. */
    colorMode: z.enum(["system", "light", "dark"]).default("system"),
    productImageRatio: z.enum(["square", "portrait"]).default("square"),
  })
  .strict();

export type ThemeConfig = z.infer<typeof themeConfigSchema>;

export const DEFAULT_THEME: ThemeConfig = themeConfigSchema.parse({});

export function resolvePalettes(config: ThemeConfig): { light: ColorScale; dark: ColorScale } {
  return {
    light: { ...LIGHT_COLORS, ...config.colors.light },
    dark: { ...DARK_COLORS, ...config.colors.dark },
  };
}

/** Theme config that also passes the AA contrast audit for both modes (used on save). */
export const themeConfigInputSchema = themeConfigSchema.superRefine((config, ctx) => {
  const { light, dark } = resolvePalettes(config);
  for (const [mode, palette] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    for (const issue of auditPalette(palette)) {
      ctx.addIssue({
        code: "custom",
        path: ["colors", mode, issue.fg],
        message: `${issue.label}: contrast ${issue.ratio}:1 is below ${issue.min}:1 (${issue.fg} on ${issue.bg}, ${mode} mode)`,
      });
    }
  }
});

function vars(palette: ColorScale, only?: Partial<Record<ColorToken, string>>): string {
  const keys = only ? (Object.keys(only) as ColorToken[]) : COLOR_TOKENS;
  return keys.map((k) => `--diau-${k}:${palette[k]};`).join("");
}

/**
 * Builds the CSS that overrides the default tokens from globals.css.
 * Only validated values are interpolated (hex colors, enum keys), so the output
 * cannot carry arbitrary CSS.
 */
export function buildThemeCss(input: unknown): string {
  const parsed = themeConfigSchema.safeParse(input);
  const config = parsed.success ? parsed.data : DEFAULT_THEME;
  const { light, dark } = resolvePalettes(config);

  const root = [
    vars(light, config.colors.light),
    `--diau-radius-scale:${RADIUS_SCALES[config.radiusScale]};`,
    `--diau-button-radius:${BUTTON_RADII[config.buttonStyle]};`,
    `--diau-font-display:var(--font-${config.fonts.display});`,
    `--diau-font-body:var(--font-${config.fonts.body});`,
    `--diau-product-ratio:${config.productImageRatio === "square" ? "1 / 1" : "4 / 5"};`,
  ].join("");

  const darkVars = vars(dark, config.colors.dark);
  let css = `:root{${root}}`;
  if (config.colorMode === "dark") {
    // Dark-only store: apply dark palette at :root regardless of class.
    css += `:root{${vars(dark)}color-scheme:dark;}`;
  } else if (darkVars) {
    css += `:root.dark{${darkVars}}`;
  }
  return css;
}
