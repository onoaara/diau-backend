import sanitizeHtml from "sanitize-html";
import { safeHref } from "../core/href";

/**
 * Allowlist for admin rich text (rich-text sections, content pages). Runs when
 * the API serves the HTML, so stored content is re-checked on every render even
 * if it was written before a rule changed.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h2", "h3", "h4", "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "mark", "small",
    "ul", "ol", "li", "blockquote", "a", "code", "pre", "table", "thead", "tbody", "tr", "th", "td",
  ],
  allowedAttributes: { a: ["href", "target", "rel"], th: ["scope", "colspan", "rowspan"], td: ["colspan", "rowspan"] },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowProtocolRelative: false,
  // Page structure belongs to the storefront: h1 is the page title, so demote it.
  transformTags: {
    h1: "h2",
    a: (tagName, attribs): sanitizeHtml.Tag => {
      const href = safeHref(attribs.href);
      if (!href) return { tagName: "span", attribs: {} };
      const out: sanitizeHtml.Attributes = { href };
      if (/^https?:/i.test(href)) Object.assign(out, { target: "_blank", rel: "noopener noreferrer" });
      return { tagName, attribs: out };
    },
  },
};

export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}
