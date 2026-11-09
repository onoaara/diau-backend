/**
 * Diau design tokens (DESIGN.md §2). These defaults are mirrored in
 * frontend/app/globals.css; admin Theme settings override them at runtime by
 * emitting `--diau-*` CSS variables.
 */

export const COLOR_TOKENS = [
  "bg",
  "bg-subtle",
  "surface",
  "surface-sunken",
  "border-subtle",
  "border",
  "border-strong",
  "fg",
  "fg-muted",
  "fg-subtle",
  "brand",
  "brand-fg",
  "accent",
  "accent-hover",
  "accent-fg",
  "accent-subtle",
  "secondary",
  "secondary-fg",
  "link",
  "sale",
  "sale-subtle",
  "success",
  "success-subtle",
  "warning",
  "warning-subtle",
  "error",
  "error-subtle",
  "info",
  "info-subtle",
  "focus-ring",
  "announcement-bg",
  "announcement-fg",
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type ColorScale = Record<ColorToken, string>;

export const LIGHT_COLORS: ColorScale = {
  bg: "#FFFFFF",
  "bg-subtle": "#F8F9FB",
  surface: "#FFFFFF",
  "surface-sunken": "#F1F3F6",
  "border-subtle": "#E5E8EE",
  border: "#D3D8E0",
  "border-strong": "#8A93A3",
  fg: "#141821",
  "fg-muted": "#3A414E",
  "fg-subtle": "#5F6878",
  brand: "#14213D",
  "brand-fg": "#FFFFFF",
  accent: "#0E7C66",
  "accent-hover": "#0A6453",
  "accent-fg": "#FFFFFF",
  "accent-subtle": "#E3F4EF",
  secondary: "#F5B700",
  "secondary-fg": "#1B1B1B",
  link: "#1F4FB8",
  sale: "#C2185B",
  "sale-subtle": "#FCE4EE",
  success: "#067647",
  "success-subtle": "#DCFAE6",
  warning: "#B54708",
  "warning-subtle": "#FEF0C7",
  error: "#B42318",
  "error-subtle": "#FEE4E2",
  info: "#1F4FB8",
  "info-subtle": "#E5EDFF",
  "focus-ring": "#1F4FB8",
  "announcement-bg": "#14213D",
  "announcement-fg": "#FFFFFF",
};

export const DARK_COLORS: ColorScale = {
  bg: "#0D1017",
  "bg-subtle": "#121620",
  surface: "#171B26",
  "surface-sunken": "#0A0C12",
  "border-subtle": "#232937",
  border: "#2E3545",
  "border-strong": "#606B85",
  fg: "#F2F4F7",
  "fg-muted": "#C1C7D2",
  "fg-subtle": "#959DAD",
  brand: "#E6ECF7",
  "brand-fg": "#14213D",
  accent: "#34C3A3",
  "accent-hover": "#5AD4B8",
  "accent-fg": "#062B23",
  "accent-subtle": "#0F2E28",
  secondary: "#FFCA3A",
  "secondary-fg": "#1B1B1B",
  link: "#8CB0FF",
  sale: "#FF6FA3",
  "sale-subtle": "#3A1324",
  success: "#47CD89",
  "success-subtle": "#0B2E1C",
  warning: "#FDB022",
  "warning-subtle": "#3A2A06",
  error: "#F97066",
  "error-subtle": "#3D1210",
  info: "#8CB0FF",
  "info-subtle": "#132042",
  "focus-ring": "#8CB0FF",
  "announcement-bg": "#1E2A47",
  "announcement-fg": "#FFFFFF",
};

/**
 * Text/background pairs that must meet WCAG AA. `min` is the required ratio:
 * 4.5 for normal text, 3 for large text and UI components.
 */
export const CONTRAST_PAIRS: ReadonlyArray<{ fg: ColorToken; bg: ColorToken; min: number; label: string }> = [
  { fg: "fg", bg: "bg", min: 4.5, label: "Body text on page" },
  { fg: "fg-muted", bg: "bg", min: 4.5, label: "Secondary text on page" },
  { fg: "fg-subtle", bg: "bg", min: 4.5, label: "Captions on page" },
  { fg: "fg-subtle", bg: "bg-subtle", min: 4.5, label: "Captions on tinted section" },
  { fg: "fg", bg: "surface", min: 4.5, label: "Text on cards" },
  { fg: "accent-fg", bg: "accent", min: 4.5, label: "Primary button label" },
  { fg: "accent-fg", bg: "accent-hover", min: 4.5, label: "Primary button label (hover)" },
  { fg: "accent", bg: "accent-subtle", min: 4.5, label: "Selected filter chip" },
  { fg: "accent", bg: "bg", min: 3, label: "Outline button border/text" },
  { fg: "brand-fg", bg: "brand", min: 4.5, label: "Header/footer text" },
  { fg: "secondary-fg", bg: "secondary", min: 4.5, label: "Highlight badge" },
  { fg: "link", bg: "bg", min: 4.5, label: "Links" },
  { fg: "sale", bg: "bg", min: 4.5, label: "Sale price" },
  { fg: "sale", bg: "sale-subtle", min: 4.5, label: "Discount badge" },
  { fg: "success", bg: "bg", min: 4.5, label: "Success text" },
  { fg: "success", bg: "success-subtle", min: 4.5, label: "Success banner" },
  { fg: "warning", bg: "warning-subtle", min: 4.5, label: "Warning banner" },
  { fg: "error", bg: "bg", min: 4.5, label: "Error text" },
  { fg: "error", bg: "error-subtle", min: 4.5, label: "Error banner" },
  { fg: "info", bg: "info-subtle", min: 4.5, label: "Info banner" },
  { fg: "focus-ring", bg: "bg", min: 3, label: "Focus ring" },
  { fg: "border-strong", bg: "bg", min: 3, label: "Input borders" },
  { fg: "border-strong", bg: "surface", min: 3, label: "Input borders on cards" },
  { fg: "announcement-fg", bg: "announcement-bg", min: 4.5, label: "Announcement bar" },
];

/** Curated fonts the admin can choose from (all self-hosted via next/font). */
export const FONT_KEYS = [
  "inter",
  "plus-jakarta-sans",
  "dm-sans",
  "manrope",
  "outfit",
  "poppins",
  "work-sans",
  "nunito-sans",
  "ibm-plex-sans",
  "space-grotesk",
  "lora",
  "source-serif-4",
] as const;
export type FontKey = (typeof FONT_KEYS)[number];

export const FONT_LABELS: Record<FontKey, string> = {
  inter: "Inter",
  "plus-jakarta-sans": "Plus Jakarta Sans",
  "dm-sans": "DM Sans",
  manrope: "Manrope",
  outfit: "Outfit",
  poppins: "Poppins",
  "work-sans": "Work Sans",
  "nunito-sans": "Nunito Sans",
  "ibm-plex-sans": "IBM Plex Sans",
  "space-grotesk": "Space Grotesk",
  lora: "Lora (serif)",
  "source-serif-4": "Source Serif 4 (serif)",
};

export const RADIUS_SCALES = { sharp: 0.4, default: 1, round: 1.4 } as const;
export type RadiusScale = keyof typeof RADIUS_SCALES;

/** Button corner style → CSS radius value. */
export const BUTTON_RADII = {
  rounded: "var(--radius-md)",
  pill: "9999px",
  square: "var(--radius-sm)",
} as const;
export type ButtonStyle = keyof typeof BUTTON_RADII;
