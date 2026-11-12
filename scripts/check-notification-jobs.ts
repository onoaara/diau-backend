/**
 * Local check for the scheduled notification job (src/realtime/jobs.ts).
 * Run against the LOCAL database only:
 *   DATABASE_URL="postgresql://diau:diauara21@localhost:5432/diau" npx tsx --env-file=.env scripts/check-notification-jobs.ts
 * It creates a throwaway shopper with two watched items and a cart, fakes three
 * situations, runs the checks once (twice, to prove no repeats), prints what was
 * sent, and deletes the shopper (which removes everything attached to it).
 */
import { productsByIds } from "../src/catalog/product-feed";
import { prisma } from "../src/db";
import { runNotificationChecks } from "../src/realtime/jobs";

const started = new Date();
const products = await prisma.product.findMany({ where: { status: "ACTIVE", stock: { gt: 0 } }, take: 3, select: { id: true } });
if (products.length < 3) throw new Error("Need three active products in the local DB.");
const shopper = await prisma.user.create({ data: { email: `jobs-check-${Date.now()}@example.test`, name: "Jobs Check" }, select: { id: true } });
await prisma.watchlistItem.createMany({ data: products.slice(0, 2).map((p) => ({ userId: shopper.id, productId: p.id })) });
await prisma.cart.create({ data: { userId: shopper.id, items: { create: [{ productId: products[2]!.id, quantity: 1 }] } } });
const watch = await prisma.watchlistItem.findMany({ where: { userId: shopper.id }, select: { id: true, userId: true, productId: true, notifiedPriceCents: true, notifiedInStock: true } });
const cart = (await prisma.cart.findFirst({ where: { userId: shopper.id }, select: { id: true, userId: true, remindedAt: true, items: { select: { id: true, updatedAt: true, createdAt: true } } } }))!;

const cards = await productsByIds(watch.map((w) => w.productId));
const priceOf = (id: string) => cards.find((c) => c.id === id)?.priceCents ?? 1000;
const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);

try {
  // 1) A price drop: pretend the watcher last saw a price 10% higher.
  await prisma.watchlistItem.update({ where: { id: watch[0]!.id }, data: { notifiedPriceCents: Math.round(priceOf(watch[0]!.productId) / 0.9), notifiedInStock: true } });
  // 2) Back in stock: pretend it was out of stock last time.
  await prisma.watchlistItem.update({ where: { id: watch[1]!.id }, data: { notifiedPriceCents: priceOf(watch[1]!.productId), notifiedInStock: false } });
  // 3) A cart left alone for four hours, never reminded.
  await prisma.$executeRaw`UPDATE "CartItem" SET "updatedAt" = ${fourHoursAgo}, "createdAt" = ${fourHoursAgo} WHERE "cartId" = ${cart.id}`;
  await prisma.cart.update({ where: { id: cart.id }, data: { remindedAt: null } });

  await runNotificationChecks();

  const sent = await prisma.notification.findMany({ where: { userId: shopper.id, createdAt: { gte: started } }, select: { type: true, title: true, body: true, link: true } });
  console.log(JSON.stringify(sent, null, 2));
  const titles = sent.map((s) => s.title);
  const ok = titles.some((t) => /Price drop|deal/i.test(t)) && titles.includes("Back in stock") && titles.includes("Still thinking it over?");
  console.log(ok ? "PASS: price drop, back in stock and cart reminder all sent" : "FAIL: missing an expected notification");

  // A second run must not repeat them.
  await runNotificationChecks();
  const again = await prisma.notification.count({ where: { userId: shopper.id, createdAt: { gte: started } } });
  console.log(again === sent.length ? "PASS: second run sent nothing new" : `FAIL: second run sent ${again - sent.length} more`);
} finally {
  // Deleting the throwaway shopper removes its watchlist, cart and notifications.
  await prisma.user.delete({ where: { id: shopper.id } });
  await prisma.$disconnect();
}
