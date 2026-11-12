import { roundToStep } from "./currency";
import { applyBps, formatMoney } from "./money";

/**
 * Order math, shared by the cart summary, the checkout quote and order placement
 * (so the total a shopper sees is the total they're charged). Pure, tested.
 * Unit prices are already promotion-adjusted (core/pricing.ts).
 */

export type TotalsLine = {
  productId: string;
  categoryId: string;
  unitPriceCents: number;
  quantity: number;
  freeShipping: boolean;
};

export type CouponRule = {
  code: string;
  type: "PERCENT" | "FIXED" | "FREE_SHIPPING";
  /** Basis points for PERCENT, cents for FIXED. */
  value: number;
  minSubtotalCents: number | null;
  scope: "ALL" | "CATEGORIES" | "PRODUCTS";
  categoryIds: string[];
  productIds: string[];
};

export type ShippingRateRule = { priceCents: number; freeOverCents: number | null; minSubtotalCents: number | null };
export type TaxRule = { rateBps: number; includeShipping: boolean } | null;

export type Totals = {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  coupon: { code: string; applied: boolean; message: string | null } | null;
};

export const lineTotal = (l: TotalsLine) => l.unitPriceCents * l.quantity;

/** Whether a shipping rate can be offered for this cart (minimum subtotal). */
export function rateAvailable(rate: ShippingRateRule, subtotalCents: number): boolean {
  return rate.minSubtotalCents === null || subtotalCents >= rate.minSubtotalCents;
}

/**
 * Shipping cost for a rate: free when every item ships free (cheapest rate only,
 * faster options still cost), or when the subtotal reaches the rate's threshold.
 */
export function shippingFor(rate: ShippingRateRule, lines: TotalsLine[], subtotalCents: number, isCheapest: boolean): number {
  if (!lines.length) return 0;
  if (isCheapest && lines.every((l) => l.freeShipping)) return 0;
  if (rate.freeOverCents !== null && subtotalCents >= rate.freeOverCents) return 0;
  return rate.priceCents;
}

export function computeTotals(input: {
  lines: TotalsLine[];
  coupon: CouponRule | null;
  /** Shipping in cents for the chosen rate (see shippingFor), or null when not chosen yet. */
  shippingCents: number | null;
  tax: TaxRule;
  /** For messages, e.g. "Spend $150.00 or more". */
  money?: { currency: string; locale: string };
  /** Smallest amount the currency can express (core/currency.ts centsStep); percent results round to it. */
  step?: number;
}): Totals {
  const step = input.step ?? 1;
  const subtotal = input.lines.reduce((sum, l) => sum + lineTotal(l), 0);
  let discount = 0;
  let shipping = input.shippingCents ?? 0;
  let couponState: Totals["coupon"] = null;

  const c = input.coupon;
  if (c) {
    const eligible = input.lines
      .filter((l) => c.scope === "ALL" || (c.scope === "CATEGORIES" ? c.categoryIds.includes(l.categoryId) : c.productIds.includes(l.productId)))
      .reduce((sum, l) => sum + lineTotal(l), 0);
    if (c.minSubtotalCents !== null && subtotal < c.minSubtotalCents) {
      couponState = { code: c.code, applied: false, message: `Spend ${formatMoney(c.minSubtotalCents, input.money?.currency, input.money?.locale)} or more to use ${c.code}.` };
    } else if (c.type !== "FREE_SHIPPING" && eligible === 0) {
      couponState = { code: c.code, applied: false, message: `${c.code} doesn't apply to the items in your cart.` };
    } else {
      if (c.type === "PERCENT") discount = roundToStep(applyBps(eligible, c.value), step);
      else if (c.type === "FIXED") discount = Math.min(c.value, eligible);
      else shipping = 0;
      couponState = { code: c.code, applied: true, message: null };
    }
  }

  discount = Math.min(discount, subtotal);
  const taxable = subtotal - discount + (input.tax?.includeShipping ? shipping : 0);
  const tax = input.tax ? roundToStep(applyBps(taxable, input.tax.rateBps), step) : 0;
  return {
    subtotalCents: subtotal,
    discountCents: discount,
    shippingCents: shipping,
    taxCents: tax,
    totalCents: subtotal - discount + shipping + tax,
    coupon: couponState,
  };
}

/** "DIA-000049" (orders are numbered from a database sequence). */
export function formatOrderNumber(orderNo: number): string {
  return `DIA-${String(orderNo).padStart(6, "0")}`;
}

export function parseOrderNumber(display: string): number | null {
  const m = /^DIA-(\d{1,12})$/i.exec(display.trim());
  return m ? Number(m[1]) : null;
}
