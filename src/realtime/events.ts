import { formatMoney, formatOrderNumber } from "../core";
import { prisma } from "../db";
import { notifyAdmins, notifyUsers } from "./notify";
import { emitToAdmins, emitToUser } from "./socket";

/*
 * What happens in the shop → who hears about it (DESIGN.md §5.22). Each
 * function is called right after the action succeeds, never awaited by the
 * response it follows (`void onX(...)`), and never throws.
 *
 * Besides notifications, they send live "something changed" events so open
 * pages refresh themselves: `admin:changed` {topic} for admin pages,
 * `order:changed` {id} and `cart:changed` for a shopper's own tabs.
 */

const safe = (fn: () => Promise<void>) => fn().catch((err) => console.error("realtime event failed", err));

const STATUS_TEXT: Record<string, { title: string; body: (no: string) => string } | undefined> = {
  CONFIRMED: { title: "Order confirmed", body: (no) => `We've confirmed order ${no} and are getting it ready.` },
  PROCESSING: { title: "Order being prepared", body: (no) => `Order ${no} is being packed.` },
  SHIPPED: { title: "Your order is on its way", body: (no) => `Order ${no} has shipped.` },
  DELIVERED: { title: "Order delivered", body: (no) => `Order ${no} has been delivered. Enjoy!` },
  CANCELLED: { title: "Order cancelled", body: (no) => `Order ${no} has been cancelled.` },
  REFUNDED: { title: "Order refunded", body: (no) => `Order ${no} has been refunded.` },
};

async function orderInfo(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNo: true, userId: true, email: true, totalCents: true, currency: true, items: { select: { productId: true, variantId: true, quantity: true, title: true } } },
  });
}

/** A shopper placed an order: admins hear about it, the shopper gets a receipt, and stock is checked. */
export const onOrderPlaced = (orderId: string) =>
  safe(async () => {
    const order = await orderInfo(orderId);
    if (!order) return;
    const no = formatOrderNumber(order.orderNo);
    const total = formatMoney(order.totalCents, order.currency);
    const items = order.items.reduce((s, i) => s + i.quantity, 0);
    await notifyAdmins({ type: "admin_order", title: `New order ${no}`, body: `${total} · ${items} ${items === 1 ? "item" : "items"} · ${order.email}`, link: `/admin/orders/${order.id}` });
    if (order.userId) {
      await notifyUsers([order.userId], { type: "order_update", title: "Order received", body: `Thanks! Order ${no} (${total}) is in. We'll let you know as it moves along.`, link: `/orders/${order.id}` });
      emitToUser(order.userId, "cart:changed");
      emitToUser(order.userId, "order:changed", { id: order.id });
    }
    emitToAdmins("admin:changed", { topic: "orders" });
    await checkLowStock(order.items);
  });

/** After a sale: tell admins when a product (or variant) just reached its low-stock level or sold out. */
async function checkLowStock(lines: { productId: string | null; variantId: string | null; quantity: number; title: string }[]) {
  for (const line of lines) {
    if (!line.productId) continue;
    const product = await prisma.product.findUnique({ where: { id: line.productId }, select: { id: true, title: true, stock: true, trackInventory: true, lowStockThreshold: true } });
    if (!product?.trackInventory) continue;
    const variant = line.variantId ? await prisma.productVariant.findUnique({ where: { id: line.variantId }, select: { stock: true } }) : null;
    const now = variant ? variant.stock : product.stock;
    const before = now + line.quantity;
    // Only on the sale that crosses the line, so each product warns once, not on every order after.
    if (now <= 0 && before > 0) {
      await notifyAdmins({ type: "admin_low_stock", title: "Sold out", body: `${line.title} just sold out.`, link: `/admin/products/${product.id}` });
    } else if (now <= product.lowStockThreshold && before > product.lowStockThreshold) {
      await notifyAdmins({ type: "admin_low_stock", title: "Low stock", body: `${line.title} is down to ${now} left.`, link: `/admin/products/${product.id}` });
    }
  }
  emitToAdmins("admin:changed", { topic: "products" });
}

/** An admin moved an order along (confirmed, shipped, delivered, cancelled…). */
export const onOrderStatusChanged = (orderId: string, status: string) =>
  safe(async () => {
    const order = await orderInfo(orderId);
    const text = STATUS_TEXT[status];
    emitToAdmins("admin:changed", { topic: "orders" });
    if (!order?.userId) return;
    emitToUser(order.userId, "order:changed", { id: order.id });
    if (text) await notifyUsers([order.userId], { type: "order_update", title: text.title, body: text.body(formatOrderNumber(order.orderNo)), link: `/orders/${order.id}` });
  });

/** A payment was marked received. */
export const onPaymentReceived = (orderId: string) =>
  safe(async () => {
    const order = await orderInfo(orderId);
    if (!order) return;
    const no = formatOrderNumber(order.orderNo);
    const total = formatMoney(order.totalCents, order.currency);
    await notifyAdmins({ type: "admin_order", title: `Payment received for ${no}`, body: `${total} from ${order.email}.`, link: `/admin/orders/${order.id}` });
    emitToAdmins("admin:changed", { topic: "orders" });
    if (!order.userId) return;
    emitToUser(order.userId, "order:changed", { id: order.id });
    await notifyUsers([order.userId], { type: "order_update", title: "Payment received", body: `We've received your payment for order ${no}.`, link: `/orders/${order.id}` });
  });

/** A refund was issued (full or partial). */
export const onRefund = (orderId: string, amountCents: number) =>
  safe(async () => {
    const order = await orderInfo(orderId);
    emitToAdmins("admin:changed", { topic: "orders" });
    if (!order?.userId) return;
    emitToUser(order.userId, "order:changed", { id: order.id });
    await notifyUsers([order.userId], {
      type: "order_update",
      title: "Refund issued",
      body: `${formatMoney(amountCents, order.currency)} is on its way back to you for order ${formatOrderNumber(order.orderNo)}.`,
      link: `/orders/${order.id}`,
    });
  });

/** Tracking details were added to a shipped order. */
export const onTrackingAdded = (orderId: string) =>
  safe(async () => {
    const order = await orderInfo(orderId);
    if (!order?.userId) return;
    emitToUser(order.userId, "order:changed", { id: order.id });
    await notifyUsers([order.userId], { type: "order_update", title: "Tracking added", body: `You can now track order ${formatOrderNumber(order.orderNo)}.`, link: `/orders/${order.id}` });
  });

/** A shopper left a review; admins hear about it when it waits for approval. */
export const onReviewCreated = (reviewId: string) =>
  safe(async () => {
    const review = await prisma.review.findUnique({ where: { id: reviewId }, select: { status: true, rating: true, authorName: true, product: { select: { title: true } } } });
    emitToAdmins("admin:changed", { topic: "reviews" });
    if (review?.status !== "PENDING") return;
    await notifyAdmins({
      type: "admin_review",
      title: "Review to approve",
      body: `${review.authorName} gave ${review.product.title} ${review.rating} ${review.rating === 1 ? "star" : "stars"}.`,
      link: "/admin/reviews",
    });
  });

/** Someone created an account (signing up, or saving a guest order as an account). */
export const onCustomerRegistered = (userId: string) =>
  safe(async () => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
    if (!user) return;
    await notifyAdmins({ type: "admin_customer", title: "New customer", body: `${user.name || user.email} just created an account.`, link: `/admin/customers/${user.id}` });
    emitToAdmins("admin:changed", { topic: "customers" });
  });

/** A signed-in shopper's cart changed: their other tabs and devices refresh their cart. */
export function onCartChanged(userId: string | null) {
  if (userId) emitToUser(userId, "cart:changed");
}
