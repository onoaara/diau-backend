/**
 * Admin-entered links are rendered as <a href>. Only allow same-site paths,
 * http(s), mailto and tel, so a stored "javascript:" URL can never reach a shopper.
 * Returns null for anything else.
 */
export function safeHref(input: string | null | undefined): string | null {
  const value = input?.trim();
  if (!value) return null;
  // Same-site path. Reject protocol-relative ("//evil") and backslash tricks ("/\evil").
  if (value.startsWith("/")) return value.startsWith("//") || value.startsWith("/\\") ? null : value;
  if (value.startsWith("#") || value.startsWith("?")) return value;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
