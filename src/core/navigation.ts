import { z } from "zod";

/** Menu keys the storefront renders. Admins may create others for content pages. */
export const MENU_KEYS = ["utility", "category-strip", "footer", "footer-legal", "mobile-bottom"] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

export const menuKeySchema = z.string().regex(/^[a-z0-9-]{1,40}$/, "Menu keys use lowercase letters, digits and dashes.");

/**
 * Lucide icon names allowed on menu items (mobile bottom nav, category icons).
 * The frontend maps each to a component, so only this list is bundled.
 */
export const MENU_ICONS = [
  "house",
  "layout-grid",
  "search",
  "heart",
  "user",
  "shopping-bag",
  "tag",
  "percent",
  "sparkles",
  "help-circle",
  "store",
] as const;
export type MenuIcon = (typeof MENU_ICONS)[number];
export const isMenuIcon = (v: string | null | undefined): v is MenuIcon => !!v && (MENU_ICONS as readonly string[]).includes(v);
