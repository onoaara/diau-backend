import type { z } from "zod";
import { canTransition, formatOrderNumber, ORDER_STATUSES, refundOutcome, type OrderStatus, type orderListQuery, type orderStatusInputSchema, type refundInputSchema } from "../core";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { HttpError, notFound } from "../lib/errors";

type Tx = Prisma.TransactionClient;

function orderWhere(q: Omit<z.infer<typeof orderListQuery>, "status"> & { status?: OrderStatus }): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [];
  if (q.q) {
    const num = /^(?:DIA-)?0*(\d{1,9})$/i.exec(q.q.trim());
    and.push({
      OR: [
        ...(num ? [{ orderNo: Number(num[1]) }] : []),
        { email: { contains: q.q, mode: "insensitive" } },
        { user: { name: { contains: q.q, mode: "insensitive" } } },
        { shippingAddress: { path: ["fullName"], string_contains: q.q } },
      ],
    });
  }
  if (q.status) and.push({ status: q.status });
  if (q.payment) and.push({ payments: { some: { status: q.payment } } });
  if (q.customerId) and.push({ userId: q.customerId });
  if (q.from) and.push({ placedAt: { gte: new Date(`${q.from}T00:00:00Z`) } });
  if (q.to) and.push({ placedAt: { lt: new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000) } });
  return and.length ? { AND: and } : {};
}

const listSelect = {
  id: true,
  orderNo: true,
  email: true,
  status: true,
  totalCents: true,
  currency: true,
  placedAt: true,
  shippingAddress: true,
  user: { select: { id: true, name: true } },
  payments: { select: { status: true, method: true }, orderBy: { createdAt: "asc" }, take: 1 },
  _count: { select: { items: true } },
} as const;

type ListRow = Prisma.OrderGetPayload<{ select: typeof listSelect }>;
const nameOf = (o: ListRow) => o.user?.name ?? ((o.shippingAddress as { fullName?: string } | null)?.fullName ?? null);

export async function listOrders(q: z.infer<typeof orderListQuery>) {
  const where = orderWhere(q);
  const orderBy: Prisma.OrderOrderByWithRelationInput = q.sort === "total" ? { totalCents: q.dir } : q.sort === "number" ? { orderNo: q.dir } : { placedAt: q.dir };
  const [rows, total, byStatus] = await Promise.all([
    prisma.order.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: listSelect }),
    prisma.order.count({ where }),
    // Tab counts ignore the status filter itself.
    prisma.order.groupBy({ by: ["status"], where: orderWhere({ ...q, status: undefined }), _count: true }),
  ]);
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, byStatus.find((b) => b.status === s)?._count ?? 0]));
  return {
    items: rows.map((o) => ({
      id: o.id,
      number: formatOrderNumber(o.orderNo),
      customerName: nameOf(o),
      email: o.email,
      customerId: o.user?.id ?? null,
      status: o.status,
      paymentStatus: o.payments[0]?.status ?? null,
      paymentMethod: o.payments[0]?.method ?? null,
      totalCents: o.totalCents,
      currency: o.currency,
      itemCount: o._count.items,
      placedAt: o.placedAt.toISOString(),
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
    counts,
  };
}

/** CSV of the filtered orders (up to 5,000 rows). Cells are quoted, and formula-like values neutralized. */
export async function exportOrdersCsv(q: z.infer<typeof orderListQuery>) {
  const rows = await prisma.order.findMany({ where: orderWhere(q), orderBy: { placedAt: "desc" }, take: 5000, select: { ...listSelect, subtotalCents: true, discountCents: true, shippingCents: true, taxCents: true, couponCode: true } });
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const money = (c: number) => (c / 100).toFixed(2);
  const header = ["Order", "Placed (UTC)", "Customer", "Email", "Status", "Payment", "Items", "Subtotal", "Discount", "Shipping", "Tax", "Total", "Currency", "Coupon"];
  const lines = rows.map((o) =>
    [formatOrderNumber(o.orderNo), o.placedAt.toISOString(), nameOf(o), o.email, o.status, o.payments[0]?.status ?? "", o._count.items, money(o.subtotalCents), money(o.discountCents), money(o.shippingCents), money(o.taxCents), money(o.totalCents), o.currency, o.couponCode ?? ""].map(cell).join(","),
  );
  return [header.map(cell).join(","), ...lines].join("\r\n");
}

export async function readOrderForAdmin(id: string) {
  const o = await prisma.order.findUnique({
    where: { id },
    include: {
      items: { orderBy: { id: "asc" }, include: { product: { select: { slug: true } } } },
      payments: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "desc" } },
      user: { select: { id: true, name: true, email: true, createdAt: true, _count: { select: { orders: true } } } },
    },
  });
  if (!o) return null;
  const actorIds = [...new Set(o.events.map((e) => e.actorId).filter((x): x is string => !!x))];
  const actors = new Map((await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name ?? u.email]));
  const paid = o.payments.reduce((s, p) => s + (["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(p.status) ? p.amountCents : 0), 0);
  const refunded = o.payments.reduce((s, p) => s + p.refundedAmountCents, 0);
  return {
    id: o.id,
    number: formatOrderNumber(o.orderNo),
    status: o.status,
    nextStatuses: ORDER_STATUSES.filter((s) => canTransition(o.status, s)),
    email: o.email,
    currency: o.currency,
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    shippingCents: o.shippingCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    paidCents: paid,
    refundedCents: refunded,
    couponCode: o.couponCode,
    shippingAddress: o.shippingAddress as Record<string, string | null>,
    billingAddress: (o.billingAddress as Record<string, string | null> | null) ?? null,
    shippingMethod: o.shippingMethod as { name: string; priceCents: number; etaMinDays: number; etaMaxDays: number },
    trackingNumber: o.trackingNumber,
    trackingCarrier: o.trackingCarrier,
    notes: o.notes,
    restockedAt: o.restockedAt?.toISOString() ?? null,
    placedAt: o.placedAt.toISOString(),
    isGuest: !o.userId,
    customer: o.user ? { id: o.user.id, name: o.user.name, email: o.user.email, since: o.user.createdAt.toISOString(), orderCount: o.user._count.orders } : null,
    items: o.items.map((i) => ({ id: i.id, title: i.title, variantTitle: i.variantTitle, sku: i.sku, imageUrl: i.imageUrl, unitPriceCents: i.unitPriceCents, quantity: i.quantity, totalCents: i.totalCents, productId: i.productId, productSlug: i.product?.slug ?? null })),
    payments: o.payments.map((p) => ({ id: p.id, provider: p.provider, method: p.method, status: p.status, amountCents: p.amountCents, refundedAmountCents: p.refundedAmountCents, reference: p.reference, createdAt: p.createdAt.toISOString() })),
    events: o.events.map((e) => ({ id: e.id, type: e.type, status: e.status, note: e.note, actor: e.actorId ? (actors.get(e.actorId) ?? "Deleted user") : null, createdAt: e.createdAt.toISOString() })),
  };
}

/** Puts every line back in stock (tracked products only) and undoes sold counts. Idempotent per order. */
async function restock(tx: Tx, orderId: string) {
  const claimed = await tx.order.updateMany({ where: { id: orderId, restockedAt: null }, data: { restockedAt: new Date() } });
  if (claimed.count === 0) return false;
  const items = await tx.orderItem.findMany({ where: { orderId }, select: { productId: true, variantId: true, quantity: true } });
  for (const i of items) {
    if (!i.productId) continue; // product deleted since
    const p = await tx.product.findUnique({ where: { id: i.productId }, select: { trackInventory: true, soldCount: true } });
    if (!p) continue;
    if (p.trackInventory) {
      if (i.variantId) await tx.productVariant.updateMany({ where: { id: i.variantId }, data: { stock: { increment: i.quantity } } });
      else await tx.product.update({ where: { id: i.productId }, data: { stock: { increment: i.quantity } } });
    }
    await tx.product.update({ where: { id: i.productId }, data: { soldCount: Math.max(0, p.soldCount - i.quantity) } });
  }
  return true;
}

export async function changeOrderStatus(id: string, input: z.infer<typeof orderStatusInputSchema>, actorId: string | null) {
  return prisma.$transaction(async (tx) => {
    const o = await tx.order.findUnique({ where: { id }, select: { id: true, orderNo: true, status: true, couponCode: true, trackingNumber: true } });
    if (!o) throw notFound("Order");
    if (o.status === input.status) throw new HttpError(409, "no_change", `The order is already ${input.status.toLowerCase()}.`);
    if (!canTransition(o.status, input.status)) throw new HttpError(409, "invalid_transition", `A ${o.status.toLowerCase()} order can't be marked ${input.status.toLowerCase()}.`);

    const data: Prisma.OrderUpdateInput = { status: input.status };
    if (input.status === "SHIPPED") {
      if (input.trackingNumber) data.trackingNumber = input.trackingNumber;
      if (input.trackingCarrier) data.trackingCarrier = input.trackingCarrier;
    }
    await tx.order.update({ where: { id }, data });
    await tx.orderEvent.create({ data: { orderId: id, status: input.status, type: "status", note: input.note ?? defaultNote(input.status), actorId } });

    let restocked = false;
    if (input.status === "CANCELLED") {
      if (input.restock) restocked = await restock(tx, id);
      // Give the coupon use back.
      if (o.couponCode) await tx.coupon.updateMany({ where: { code: o.couponCode, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
      // Unpaid payments are void; paid ones must be refunded explicitly (money moves outside Diau).
      await tx.payment.updateMany({ where: { orderId: id, status: { in: ["PENDING", "AUTHORIZED"] } }, data: { status: "FAILED" } });
    }
    return { number: formatOrderNumber(o.orderNo), from: o.status, to: input.status, restocked };
  });
}

const defaultNote = (s: OrderStatus) =>
  ({ PENDING: "Order placed", CONFIRMED: "Order confirmed", PROCESSING: "Preparing your order", SHIPPED: "Shipped", DELIVERED: "Delivered", CANCELLED: "Order cancelled", REFUNDED: "Refunded" })[s];

export async function markPaymentPaid(orderId: string, paymentId: string, reference: string | null, actorId: string | null) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.payment.findFirst({ where: { id: paymentId, orderId }, select: { id: true, status: true, amountCents: true, order: { select: { orderNo: true, status: true } } } });
    if (!p) throw notFound("Payment");
    if (p.status !== "PENDING" && p.status !== "AUTHORIZED") throw new HttpError(409, "invalid_payment_state", "Only pending payments can be marked paid.");
    if (p.order.status === "CANCELLED") throw new HttpError(409, "order_cancelled", "This order was cancelled.");
    await tx.payment.update({ where: { id: paymentId }, data: { status: "PAID", reference } });
    await tx.orderEvent.create({ data: { orderId, status: p.order.status, type: "payment", note: `Payment received${reference ? ` (ref. ${reference})` : ""}`, actorId } });
    // Paying a pending order confirms it.
    if (p.order.status === "PENDING") {
      await tx.order.update({ where: { id: orderId }, data: { status: "CONFIRMED" } });
      await tx.orderEvent.create({ data: { orderId, status: "CONFIRMED", type: "status", note: "Payment received, order confirmed", actorId } });
    }
    return { number: formatOrderNumber(p.order.orderNo), amountCents: p.amountCents };
  });
}

/**
 * Records a refund. No gateway is connected, so the money is returned outside
 * Diau (bank transfer, cash); this keeps the books and stock right.
 */
export async function refundOrder(orderId: string, input: z.infer<typeof refundInputSchema>, actorId: string | null) {
  return prisma.$transaction(async (tx) => {
    const o = await tx.order.findUnique({ where: { id: orderId }, select: { orderNo: true, status: true, currency: true, payments: { where: { status: { in: ["PAID", "PARTIALLY_REFUNDED"] } }, orderBy: { createdAt: "asc" } } } });
    if (!o) throw notFound("Order");
    const p = o.payments[0];
    if (!p) throw new HttpError(409, "not_paid", "Only paid orders can be refunded. Cancel unpaid orders instead.");
    const outcome = refundOutcome(p, input.amountCents);
    if (!outcome.ok) throw new HttpError(422, "validation_error", outcome.message, { amountCents: [outcome.message] });
    await tx.payment.update({ where: { id: p.id }, data: { status: outcome.status, refundedAmountCents: outcome.refunded } });
    const amount = (input.amountCents / 100).toFixed(2);
    await tx.orderEvent.create({ data: { orderId, status: o.status, type: "refund", note: `Refunded ${amount} ${o.currency}: ${input.reason}`, actorId } });
    let restocked = false;
    if (input.restock) restocked = await restock(tx, orderId);
    if (outcome.full && o.status !== "REFUNDED") {
      await tx.order.update({ where: { id: orderId }, data: { status: "REFUNDED" } });
      await tx.orderEvent.create({ data: { orderId, status: "REFUNDED", type: "status", note: "Refunded", actorId } });
    }
    return { number: formatOrderNumber(o.orderNo), amountCents: input.amountCents, full: outcome.full, restocked };
  });
}

export async function addOrderNote(orderId: string, note: string, actorId: string | null) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, orderNo: true } });
  if (!o) throw notFound("Order");
  await prisma.orderEvent.create({ data: { orderId, status: o.status, type: "note", note, actorId } });
  return { number: formatOrderNumber(o.orderNo) };
}

export async function updateTracking(orderId: string, input: { trackingNumber: string | null; trackingCarrier: string | null }, actorId: string | null) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, orderNo: true } });
  if (!o) throw notFound("Order");
  await prisma.order.update({ where: { id: orderId }, data: input });
  await prisma.orderEvent.create({ data: { orderId, status: o.status, type: "tracking", note: input.trackingNumber ? `Tracking: ${input.trackingCarrier ? `${input.trackingCarrier} ` : ""}${input.trackingNumber}` : "Tracking removed", actorId } });
  return { number: formatOrderNumber(o.orderNo) };
}
