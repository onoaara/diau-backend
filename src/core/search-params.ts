/**
 * URL contract for results pages (DESIGN.md §5.6: all state lives in the URL).
 *   /search?q=phone&category=electronics&brand=apple,samsung&price=100-500
 *          &rating=4&free_shipping=1&color=black&sort=price_asc&page=2&view=list
 * Custom attribute filters use the attribute's slug as the parameter name
 * (prefixed with "a-" if it collides with a reserved name).
 */

export const SORT_OPTIONS = [
  { value: "best", label: "Best match" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "newest", label: "Newest" },
  { value: "rating", label: "Top rated" },
  { value: "ending", label: "Ending soonest" },
] as const;
export type SortKey = (typeof SORT_OPTIONS)[number]["value"];
export const isSortKey = (v: unknown): v is SortKey => SORT_OPTIONS.some((o) => o.value === v);

/** Parameter names with fixed meanings; attribute slugs must not shadow them. */
export const RESERVED_PARAMS = [
  "q", "category", "sort", "page", "view", "tag", "image",
  "price", "brand", "condition", "rating", "free_shipping", "location",
] as const;

export function attributeParam(slug: string): string {
  return (RESERVED_PARAMS as readonly string[]).includes(slug) ? `a-${slug}` : slug;
}

export const CONDITION_PARAMS = { new: "NEW", used: "USED", refurbished: "REFURBISHED" } as const;
export const CONDITION_LABELS = { NEW: "New", USED: "Used", REFURBISHED: "Refurbished" } as const;

/** "a,b,,a" → ["a","b"] (trimmed, de-duplicated, bounded). */
export function parseList(value: string | undefined | null, max = 30): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((v) => v.trim()).filter((v) => v.length > 0 && v.length <= 100))].slice(0, max);
}

/**
 * "20-100" / "20-" / "-100" → { from, to } (non-negative numbers, swapped if
 * reversed). Null when nothing usable was given.
 */
export function parseRange(value: string | undefined | null): { from: number | null; to: number | null } | null {
  if (!value) return null;
  const m = /^\s*(\d+(?:\.\d+)?)?\s*-\s*(\d+(?:\.\d+)?)?\s*$/.exec(value);
  if (!m) return null;
  let from = m[1] !== undefined ? Number(m[1]) : null;
  let to = m[2] !== undefined ? Number(m[2]) : null;
  if (from === null && to === null) return null;
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  return { from, to };
}

export function formatRange(from: number | null, to: number | null, format: (n: number) => string): string {
  if (from !== null && to !== null) return `${format(from)}–${format(to)}`;
  if (from !== null) return `${format(from)} and up`;
  return `Up to ${format(to ?? 0)}`;
}
