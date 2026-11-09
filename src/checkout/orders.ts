import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { formatOrderNumber } from "../core";
import { prisma } from "../db";
import { conflict, notFound } from "../lib/errors";
import { hashPassword } from "../lib/password";
import { readSite } from "../routes/settings";
import { hashOrderKey } from "./checkout";

const addressDto = z.object({
  fullName: z.string(),
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  region: z.string().optional(),
  postalCode: z.string(),
  country: z.string(),
  phone: z.string().optional(),
});

export const orderDto = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"]),
  email: z.string(),
  placedAt: z.string(),
  currency: z.string(),
  subtotalCents: z.number().int(),
  discountCents: z.number().int(),
  shippingCents: z.number().int(),
  taxCents: z.number().int(),
  totalCents: z.number().int(),
  couponCode: z.string().nullable(),
  shippingAddress: addressDto,
  billingAddress: addressDto.nullable(),
  shippingMethod: z.object({ name: z.string(), etaMinDays: z.number().int(), etaMaxDays: z.number().int() }),
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      variantTitle: z.string().nullable(),
      imageUrl: z.string().nullable(),
      slug: z.string().nullable(),
      unitPriceCents: z.number().int(),
      quantity: z.number().int(),
      totalCents: z.number().int(),
    }),
  ),
  payment: z.object({ method: z.string(), label: z.string(), status: z.string(), instructions: z.string() }).nullable(),
  events: z.array(z.object({ status: z.string(), note: z.string().nullable(), createdAt: z.string() })),
  tracking: z.object({ number: z.string(), carrier: z.string().nullable() }).nullable(),
  /** Guest orders: whether an account with this email already exists (for the "create an account" panel). */
  isGuest: z.boolean(),
  accountExists: z.boolean(),
});
export type OrderDto = z.infer<typeof orderDto>;

const sameToken = (given: string, storedHash: string | null) => {
  if (!storedHash) return false;
  const a = Buffer.from(hashOrderKey(given));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** An order its owner (signed in) or a guest holding the order link may see. Null otherwise. */
export async function readOrder(orderId: string, access: { userId: string | null; key: string | null }): Promise<OrderDto | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { orderBy: { id: "asc" }, include: { product: { select: { slug: true } } } },
      payments: { orderBy: { createdAt: "desc" }, take: 1 },
      // Internal notes, payment and refund entries stay in the admin.
      events: { where: { type: "status" }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!o) return null;
  const allowed = (access.userId && o.userId === access.userId) || (access.key && sameToken(access.key, o.guestAccessToken));
  if (!allowed) return null;

  const site = await readSite();
  const pay = o.payments[0];
  const method = pay ? site.checkout.paymentMethods.find((m) => m.id === pay.method) : null;
  const ship = addressDto.safeParse(o.shippingAddress);
  const bill = addressDto.safeParse(o.billingAddress);
  const sm = o.shippingMethod as { name?: string; etaMinDays?: number; etaMaxDays?: number } | null;
  const accountExists = !o.userId ? (await prisma.user.count({ where: { email: { equals: o.email, mode: "insensitive" } } })) > 0 : true;

  return {
    id: o.id,
    number: formatOrderNumber(o.orderNo),
    status: o.status,
    email: o.email,
    placedAt: o.placedAt.toISOString(),
    currency: o.currency,
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    shippingCents: o.shippingCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    couponCode: o.couponCode,
    shippingAddress: ship.success ? ship.data : { fullName: "", line1: "", city: "", postalCode: "", country: "" },
    billingAddress: bill.success ? bill.data : null,
    shippingMethod: { name: sm?.name ?? "Standard", etaMinDays: sm?.etaMinDays ?? 0, etaMaxDays: sm?.etaMaxDays ?? 0 },
    items: o.items.map((i) => ({
      id: i.id,
      title: i.title,
      variantTitle: i.variantTitle,
      imageUrl: i.imageUrl,
      slug: i.product?.slug ?? null,
      unitPriceCents: i.unitPriceCents,
      quantity: i.quantity,
      totalCents: i.totalCents,
    })),
    payment: pay ? { method: pay.method ?? "manual", label: method?.label ?? pay.method ?? "Manual payment", status: pay.status, instructions: method?.instructions ?? "" } : null,
    events: o.events.map((e) => ({ status: e.status, note: e.note, createdAt: e.createdAt.toISOString() })),
    tracking: o.trackingNumber ? { number: o.trackingNumber, carrier: o.trackingCarrier } : null,
    isGuest: !o.userId,
    accountExists,
  };
}

/**
 * Guest → account from the confirmation page: creates a customer with the
 * order's email and attaches this order. Refuses when the email already has an
 * account (the shopper signs in instead), so nobody can take over an account.
 */
export async function claimGuestOrder(orderId: string, key: string, password: string) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, userId: true, email: true, guestAccessToken: true, shippingAddress: true } });
  if (!o || o.userId || !sameToken(key, o.guestAccessToken)) throw notFound("Order");
  const exists = await prisma.user.findFirst({ where: { email: { equals: o.email, mode: "insensitive" } }, select: { id: true } });
  if (exists) throw conflict("An account with this email already exists. Sign in to see your orders.");
  const ship = addressDto.safeParse(o.shippingAddress);
  const user = await prisma.user.create({
    data: { email: o.email, name: ship.success ? ship.data.fullName : null, passwordHash: await hashPassword(password), role: "CUSTOMER" },
    select: { id: true },
  });
  await prisma.order.update({ where: { id: o.id }, data: { userId: user.id } });
  return user.id;
}

export async function listOrders(userId: string) {
  const rows = await prisma.order.findMany({
    where: { userId },
    orderBy: { placedAt: "desc" },
    take: 50,
    select: { id: true, orderNo: true, status: true, placedAt: true, totalCents: true, currency: true, items: { take: 4, select: { title: true, imageUrl: true, quantity: true } }, _count: { select: { items: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    number: formatOrderNumber(r.orderNo),
    status: r.status,
    placedAt: r.placedAt.toISOString(),
    totalCents: r.totalCents,
    currency: r.currency,
    itemCount: r._count.items,
    items: r.items,
  }));
}
