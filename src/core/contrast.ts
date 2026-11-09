import { CONTRAST_PAIRS, type ColorScale } from "./tokens";

const HEX_RE = /^#([0-9a-f]{6})$/i;

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a #RRGGBB color. */
export function luminance(hex: string): number {
  const m = HEX_RE.exec(hex);
  if (!m?.[1]) throw new Error(`Invalid hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colors, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastIssue = {
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
};

/** Returns every required pair in a palette that fails its minimum ratio. */
export function auditPalette(colors: ColorScale): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const pair of CONTRAST_PAIRS) {
    const ratio = contrastRatio(colors[pair.fg], colors[pair.bg]);
    if (ratio < pair.min) {
      issues.push({ label: pair.label, fg: pair.fg, bg: pair.bg, ratio: Math.round(ratio * 100) / 100, min: pair.min });
    }
  }
  return issues;
}
