/** Pure helpers for building safe search queries (unit-tested). */

const MAX_TOKENS = 8;

/** Lowercased word tokens (letters and digits only, any script). */
export function tokenize(input: string): string[] {
  return (input.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TOKENS);
}

/**
 * Prefix tsquery for as-you-type matching: "apple lapt" → "apple:* & lapt:*".
 * Tokens contain only letters/digits, so the string is safe for to_tsquery().
 */
export function toPrefixTsQuery(input: string): string | null {
  const tokens = tokenize(input);
  return tokens.length ? tokens.map((t) => `${t}:*`).join(" & ") : null;
}

/** Escapes LIKE/ILIKE wildcards so user input matches literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
