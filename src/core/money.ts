/** Money helpers. All amounts are integer minor units (cents). */

export function formatMoney(cents: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

/** Percent off between compare-at and price, rounded down (never overstates a deal). */
export function discountPercent(priceCents: number, compareAtCents: number | null | undefined): number {
  if (!compareAtCents || compareAtCents <= priceCents || compareAtCents <= 0) return 0;
  return Math.floor(((compareAtCents - priceCents) / compareAtCents) * 100);
}

/** Applies basis points (1500 = 15%), rounding to the nearest cent. */
export function applyBps(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10_000);
}

export function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}
