import type { SiteConfig } from "./site";

/**
 * Shopper currencies. The admin enters every price in the store's base currency
 * (site.currency) and maintains a rate for each extra currency shoppers may pick
 * (site.currencies: units of that currency per 1 unit of the base). Cart,
 * checkout and orders are priced in the shopper's currency: catalog amounts are
 * converted per unit, rounded to the currency's minor unit, and all order math
 * then runs in that currency. Mirrored in frontend/lib/money.ts (display).
 */

export type CurrencyContext = {
  /** The currency amounts are in. */
  code: string;
  /** Units of `code` per 1 unit of the base currency (1 for the base itself). */
  rate: number;
  /** The store's base currency. */
  base: string;
};

/** Minor-unit digits for a currency per Intl (USD 2, JPY 0, KWD 3). */
export function fractionDigits(code: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Smallest step, in our cents (amount × 100), that the currency can express:
 * 1 for 2+ decimals, 100 for zero-decimal currencies like JPY.
 */
export function centsStep(code: string): number {
  return 10 ** Math.max(0, 2 - fractionDigits(code));
}

export const roundToStep = (cents: number, step: number) => (step <= 1 ? Math.round(cents) : Math.round(cents / step) * step);

/** Converts a base-currency amount into the context currency, rounded to its minor unit. */
export function convertCents(baseCents: number, ctx: CurrencyContext): number {
  if (ctx.code === ctx.base || ctx.rate === 1) return Math.round(baseCents);
  return roundToStep(baseCents * ctx.rate, centsStep(ctx.code));
}

export const convertNullable = (cents: number | null, ctx: CurrencyContext) => (cents === null ? null : convertCents(cents, ctx));

/** The base context: no conversion. */
export const baseContext = (site: Pick<SiteConfig, "currency">): CurrencyContext => ({ code: site.currency, rate: 1, base: site.currency });

/**
 * The context for a requested currency code (from the shopper's cookie). Falls
 * back to the base when the code is missing, malformed or no longer offered.
 */
export function resolveCurrency(site: Pick<SiteConfig, "currency" | "currencies">, requested: string | null | undefined): CurrencyContext {
  const code = typeof requested === "string" ? requested.trim().toUpperCase() : "";
  if (!code || code === site.currency) return baseContext(site);
  const offered = site.currencies.find((c) => c.code === code && c.rate > 0);
  return offered ? { code: offered.code, rate: offered.rate, base: site.currency } : baseContext(site);
}
