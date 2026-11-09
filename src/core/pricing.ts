import { applyBps } from "./money";

/**
 * Shopper-facing price of a product, with promotions applied. The storefront
 * (cards, PDP) and checkout must use this same function, so the price a shopper
 * sees is the price they pay.
 */

export type PromotionDiscount = {
  promotionId: string;
  discountType: "PERCENT" | "FIXED" | "FREE_SHIPPING";
  /** Basis points for PERCENT, cents for FIXED. */
  value: number;
  /** Per-product deal price that overrides the promotion's discount. */
  specialPriceCents: number | null;
  endsAt: Date;
};

export type EffectivePrice = {
  priceCents: number;
  /** Struck-through "was" price, or null when there's no genuine reduction. */
  compareAtPriceCents: number | null;
  /** The promotion that set the price, if any. */
  promotion: { id: string; endsAt: Date } | null;
  /** True when a FREE_SHIPPING promotion applies. */
  freeShippingPromo: boolean;
};

export function promotionPrice(basePriceCents: number, promo: PromotionDiscount): number {
  if (promo.specialPriceCents !== null) return Math.max(0, promo.specialPriceCents);
  switch (promo.discountType) {
    case "PERCENT":
      return Math.max(0, basePriceCents - applyBps(basePriceCents, promo.value));
    case "FIXED":
      return Math.max(0, basePriceCents - promo.value);
    case "FREE_SHIPPING":
      return basePriceCents;
  }
}

/**
 * Lowest price among the active promotions (never above the base price).
 * Honest "was" price: under a promotion it's the regular price the shopper would
 * otherwise pay, not a list price; without one it's the product's compare-at
 * price, only when that's genuinely higher.
 */
export function effectivePrice(
  product: { priceCents: number; compareAtPriceCents: number | null },
  activePromotions: readonly PromotionDiscount[],
): EffectivePrice {
  const base = product.priceCents;
  let best: { price: number; promo: PromotionDiscount } | null = null;
  for (const promo of activePromotions) {
    const price = promotionPrice(base, promo);
    if (price < base && (!best || price < best.price)) best = { price, promo };
  }
  const freeShippingPromo = activePromotions.some((p) => p.discountType === "FREE_SHIPPING");

  if (best) {
    return {
      priceCents: best.price,
      compareAtPriceCents: base,
      promotion: { id: best.promo.promotionId, endsAt: best.promo.endsAt },
      freeShippingPromo,
    };
  }
  const compareAt = product.compareAtPriceCents;
  return {
    priceCents: base,
    compareAtPriceCents: compareAt !== null && compareAt > base ? compareAt : null,
    promotion: null,
    freeShippingPromo,
  };
}
