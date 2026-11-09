import { z } from "zod";
import { PERMISSIONS, ROLES } from "./auth";
import { tiptapDocSchema } from "./catalog-admin";

/**
 * Admin rules and input schemas for orders, payments, refunds, customers,
 * promotions, coupons, reviews, content pages and the team (phase 10).
 */

const id = z.string().regex(/^[a-z0-9]{10,40}$/i, "Invalid id.");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const date = z.coerce.date();

// ── Orders ───────────────────────────────────────────────────────────────────

export const ORDER_STATUSES = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Where an order can go next by hand. REFUNDED is reached only through a full
 * refund; CANCELLED and REFUNDED are final.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "SHIPPED", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus) => ORDER_TRANSITIONS[from].includes(to);

export const orderListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  payment: z.enum(["PENDING", "PAID", "REFUNDED", "PARTIALLY_REFUNDED"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  customerId: id.optional(),
  sort: z.enum(["placed", "total", "number"]).default("placed"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().refine((n) => [25, 50, 100].includes(n)).default(25),
});

export const orderStatusInputSchema = z
  .object({
    status: z.enum(ORDER_STATUSES),
    note: optionalText(500),
    trackingNumber: optionalText(100),
    trackingCarrier: optionalText(60),
    /** Cancelling: put the items back in stock (default yes). */
    restock: z.boolean().default(true),
  })
  .refine((v) => v.status !== "REFUNDED", { path: ["status"], message: "Use Refund to refund an order." });

export const trackingInputSchema = z.object({ trackingNumber: optionalText(100), trackingCarrier: optionalText(60) });
export const orderNoteSchema = z.object({ note: z.string().trim().min(1, "Write a note.").max(1000) });
export const markPaidSchema = z.object({ reference: optionalText(120) });
export const refundInputSchema = z.object({
  amountCents: z.number().int().min(1, "Enter an amount."),
  reason: z.string().trim().min(3, "Say why (customers don't see this).").max(300),
  restock: z.boolean().default(false),
});

/** Result of refunding `amount` on a payment: the new payment status, or why it can't be done. */
export function refundOutcome(p: { status: string; amountCents: number; refundedAmountCents: number }, amount: number): { ok: true; refunded: number; status: "PARTIALLY_REFUNDED" | "REFUNDED"; full: boolean } | { ok: false; message: string } {
  if (!["PAID", "PARTIALLY_REFUNDED"].includes(p.status)) return { ok: false, message: "Only paid orders can be refunded. Cancel unpaid orders instead." };
  const left = p.amountCents - p.refundedAmountCents;
  if (amount > left) return { ok: false, message: `You can refund at most ${(left / 100).toFixed(2)}.` };
  const refunded = p.refundedAmountCents + amount;
  const full = refunded >= p.amountCents;
  return { ok: true, refunded, status: full ? "REFUNDED" : "PARTIALLY_REFUNDED", full };
}

// ── Customers & team ─────────────────────────────────────────────────────────

export const customerListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "blocked"]).optional(),
  sort: z.enum(["joined", "orders", "spent", "name"]).default("joined"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().refine((n) => [25, 50, 100].includes(n)).default(25),
});

export const customerUpdateSchema = z.object({ name: optionalText(80), isActive: z.boolean() });

export const teamMemberSchema = z.object({
  role: z.enum(ROLES),
  /** Empty = the role's defaults. */
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
});

// ── Promotions & coupons ─────────────────────────────────────────────────────

export const promotionInputSchema = z
  .object({
    name: z.string().trim().min(2, "Name the promotion.").max(80),
    type: z.enum(["SALE", "FLASH_SALE", "DEAL_OF_THE_DAY"]),
    discountType: z.enum(["PERCENT", "FIXED"]),
    /** Basis points for PERCENT (1500 = 15%), cents for FIXED. */
    value: z.number().int().min(1, "Enter a discount."),
    startsAt: date,
    endsAt: date,
    isActive: z.boolean(),
    products: z
      .array(z.object({ productId: id, specialPriceCents: z.number().int().min(1).nullable() }))
      .min(1, "Add at least one product.")
      .max(500)
      .refine((p) => new Set(p.map((x) => x.productId)).size === p.length, "Each product can be added once."),
  })
  .superRefine((p, ctx) => {
    if (p.endsAt <= p.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start." });
    if (p.discountType === "PERCENT" && p.value > 9000) ctx.addIssue({ code: "custom", path: ["value"], message: "Up to 90% off." });
  });
export type PromotionInput = z.infer<typeof promotionInputSchema>;

export const normalizeCouponCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

export const couponInputSchema = z
  .object({
    code: z
      .string()
      .transform(normalizeCouponCode)
      .pipe(z.string().regex(/^[A-Z0-9_-]{3,30}$/, "Use 3–30 letters, digits, - or _.")),
    description: optionalText(200),
    type: z.enum(["PERCENT", "FIXED", "FREE_SHIPPING"]),
    value: z.number().int().min(0),
    minSubtotalCents: z.number().int().min(1).nullable(),
    maxUses: z.number().int().min(1).nullable(),
    perCustomerLimit: z.number().int().min(1).nullable(),
    scope: z.enum(["ALL", "CATEGORIES", "PRODUCTS"]),
    categoryIds: z.array(id).max(100),
    productIds: z.array(id).max(500),
    startsAt: date.nullable(),
    endsAt: date.nullable(),
    isActive: z.boolean(),
  })
  .superRefine((c, ctx) => {
    if (c.type === "PERCENT" && (c.value < 100 || c.value > 9000)) ctx.addIssue({ code: "custom", path: ["value"], message: "Between 1% and 90%." });
    if (c.type === "FIXED" && c.value < 1) ctx.addIssue({ code: "custom", path: ["value"], message: "Enter an amount." });
    if (c.startsAt && c.endsAt && c.endsAt <= c.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start." });
    if (c.scope === "CATEGORIES" && !c.categoryIds.length) ctx.addIssue({ code: "custom", path: ["categoryIds"], message: "Choose at least one category." });
    if (c.scope === "PRODUCTS" && !c.productIds.length) ctx.addIssue({ code: "custom", path: ["productIds"], message: "Choose at least one product." });
  });
export type CouponInput = z.infer<typeof couponInputSchema>;

// ── Reviews ──────────────────────────────────────────────────────────────────

export const reviewListQuery = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export const reviewModerationSchema = z.object({ ids: z.array(id).min(1).max(100), action: z.enum(["approve", "reject", "delete"]) });

// ── Content pages ────────────────────────────────────────────────────────────

/** First path segments the storefront already uses; pages can't take them. */
export const RESERVED_SLUGS = [
  "home", "admin", "api", "account", "cart", "checkout", "orders", "search", "sign-in", "register", "preview", "c", "p", "categories", "brands", "_next", "favicon.ico", "robots.txt", "sitemap.xml",
];

export const contentPageInputSchema = z
  .object({
    title: z.string().trim().min(1, "Enter a title.").max(120),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and dashes.")
      .max(80)
      .refine((s) => !RESERVED_SLUGS.includes(s), "That address is used by the store. Pick another.")
      .optional(),
    kind: z.enum(["CONTENT", "LANDING"]),
    status: z.enum(["DRAFT", "PUBLISHED"]),
    content: tiptapDocSchema.nullable(),
    seoTitle: optionalText(70),
    seoDescription: optionalText(160),
  });
export type ContentPageInput = z.infer<typeof contentPageInputSchema>;

// ── Audit log ────────────────────────────────────────────────────────────────

export const auditListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  entity: z.string().regex(/^[A-Za-z]{1,40}$/).optional(),
  actorId: id.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
