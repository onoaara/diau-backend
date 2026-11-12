import { readPrefs, wantsType } from "../core";
import { productsByIds, type ProductCardDto } from "../catalog/product-feed";
import { prisma } from "../db";
import { notifyUsers } from "./notify";

/*
 * Scheduled notification checks (DESIGN.md §5.22), every 5 minutes. Prices,
 * stock and deals can change from many places (a product edit, a promotion
 * starting on its own, a restock), so instead of hooking each one, this compares
 * what shoppers were last told with how things are now:
 *   - watchlist: price dropped, or back in stock        → watchlist_deal
 *   - cart: a line's price dropped                      → cart_reminder
 *   - cart: untouched for 3 hours (once per change)      → cart_reminder
 *   - a promotion just started                          → new_deal (opt-in)
 * First sight of an item only records a baseline, so turning this on doesn't
 * flood anyone. Prices are compared in the store currency and described as a
 * percentage, which reads right in whatever currency the shopper uses.
 * A Postgres advisory lock keeps it to one run at a time across servers.
 */

const EVERY_MS = 5 * 60 * 1000;
const CART_IDLE_MS = 3 * 60 * 60 * 1000;
/** Carts older than this aren't worth a reminder. */
const CART_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_KEY = 74_213_001;

const pctLess = (now: number, before: number) => Math.round(((before - now) / before) * 100);
const productLink = (p: ProductCardDto) => `/p/${p.slug}`;

async function cardsFor(productIds: string[]) {
  const unique = [...new Set(productIds)];
  const cards = new Map<string, ProductCardDto>();
  for (let i = 0; i < unique.length; i += 200) for (const c of await productsByIds(unique.slice(i, i + 200))) cards.set(c.id, c);
  return cards;
}

async function checkWatchlists() {
  const items = await prisma.watchlistItem.findMany({ where: { user: { isActive: true } }, select: { id: true, userId: true, productId: true, notifiedPriceCents: true, notifiedInStock: true } });
  if (!items.length) return;
  const cards = await cardsFor(items.map((i) => i.productId));
  for (const item of items) {
    const card = cards.get(item.productId);
    if (!card) continue;
    const firstLook = item.notifiedPriceCents === null || item.notifiedInStock === null;
    if (!firstLook) {
      if (card.inStock && item.notifiedInStock === false) {
        await notifyUsers([item.userId], { type: "watchlist_deal", title: "Back in stock", body: `${card.title} is available again.`, link: productLink(card), imageUrl: card.image?.url });
      } else if (card.inStock && card.priceCents < item.notifiedPriceCents!) {
        const pct = pctLess(card.priceCents, item.notifiedPriceCents!);
        if (pct >= 1) {
          const deal = card.compareAtPriceCents !== null && card.compareAtPriceCents > card.priceCents;
          await notifyUsers([item.userId], {
            type: "watchlist_deal",
            title: deal ? "A deal on something you're watching" : "Price drop on your watchlist",
            body: `${card.title} is now ${pct}% less.`,
            link: productLink(card),
            imageUrl: card.image?.url,
          });
        }
      }
    }
    if (item.notifiedPriceCents !== card.priceCents || item.notifiedInStock !== card.inStock) {
      await prisma.watchlistItem.update({ where: { id: item.id }, data: { notifiedPriceCents: card.priceCents, notifiedInStock: card.inStock } });
    }
  }
}

async function checkCarts(now: Date) {
  const carts = await prisma.cart.findMany({
    where: { userId: { not: null }, user: { isActive: true }, items: { some: { savedForLater: false } } },
    select: { id: true, userId: true, remindedAt: true, items: { where: { savedForLater: false }, select: { id: true, productId: true, notifiedPriceCents: true, createdAt: true, updatedAt: true } } },
  });
  if (!carts.length) return;
  const cards = await cardsFor(carts.flatMap((c) => c.items.map((i) => i.productId)));

  for (const cart of carts) {
    const userId = cart.userId!;
    // Price drops on lines already in the cart.
    const dropped: { card: ProductCardDto; pct: number }[] = [];
    for (const line of cart.items) {
      const card = cards.get(line.productId);
      if (!card) continue;
      if (line.notifiedPriceCents !== null && card.inStock && card.priceCents < line.notifiedPriceCents) {
        const pct = pctLess(card.priceCents, line.notifiedPriceCents);
        if (pct >= 1) dropped.push({ card, pct });
      }
      if (line.notifiedPriceCents !== card.priceCents) {
        // Raw update so the line's updatedAt (the "last touched" clock below) isn't bumped.
        await prisma.$executeRaw`UPDATE "CartItem" SET "notifiedPriceCents" = ${card.priceCents} WHERE id = ${line.id}`;
      }
    }
    if (dropped.length) {
      const first = dropped[0]!;
      await notifyUsers([userId], {
        type: "cart_reminder",
        title: "Price drop in your cart",
        body: dropped.length === 1 ? `${first.card.title} is now ${first.pct}% less.` : `${dropped.length} items in your cart are now cheaper.`,
        link: "/cart",
        imageUrl: first.card.image?.url,
      });
    }

    // "You left something in your cart": once per change, after 3 quiet hours, not for old carts.
    const lastTouched = Math.max(...cart.items.map((i) => Math.max(i.createdAt.getTime(), i.updatedAt.getTime())));
    const idle = now.getTime() - lastTouched;
    if (idle >= CART_IDLE_MS && idle <= CART_STALE_MS && (!cart.remindedAt || cart.remindedAt.getTime() < lastTouched)) {
      const count = cart.items.length;
      const card = cards.get(cart.items[0]!.productId);
      await notifyUsers([userId], {
        type: "cart_reminder",
        title: "Still thinking it over?",
        body: count === 1 && card ? `${card.title} is waiting in your cart.` : `${count} items are waiting in your cart.`,
        link: "/cart",
        imageUrl: card?.image?.url,
      });
      await prisma.cart.update({ where: { id: cart.id }, data: { remindedAt: now } });
    }
  }
}

async function checkNewDeals(now: Date) {
  const started = await prisma.promotion.findMany({
    where: { isActive: true, announcedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
    select: { id: true, name: true, startsAt: true, products: { select: { productId: true }, take: 1 } },
  });
  if (!started.length) return;
  const fresh = started.filter((p) => now.getTime() - p.startsAt.getTime() < 24 * 60 * 60 * 1000);
  if (fresh.length) {
    // Opt-in only: people who switched "New deals" on.
    const users = await prisma.user.findMany({ where: { isActive: true, notificationPrefs: { not: undefined } }, select: { id: true, notificationPrefs: true } });
    const ids = users.filter((u) => wantsType(readPrefs(u.notificationPrefs), "new_deal")).map((u) => u.id);
    for (const promo of fresh) {
      const productId = promo.products[0]?.productId;
      const card = productId ? (await productsByIds([productId]))[0] : undefined;
      await notifyUsers(ids, { type: "new_deal", title: "New deal", body: `${promo.name} has started. Take a look before it ends.`, link: card ? productLink(card) : "/", imageUrl: card?.image?.url });
    }
  }
  // Older ones (already running when this went live) are marked without announcing.
  await prisma.promotion.updateMany({ where: { id: { in: started.map((p) => p.id) } }, data: { announcedAt: now } });
}

let timer: NodeJS.Timeout | null = null;

export async function runNotificationChecks(now = new Date()) {
  const [row] = await prisma.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
  if (!row?.locked) return;
  try {
    await checkWatchlists();
    await checkCarts(now);
    await checkNewDeals(now);
  } catch (err) {
    console.error("notification checks failed", err);
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
  }
}

export function startNotificationJobs() {
  if (timer) return;
  timer = setInterval(() => void runNotificationChecks(), EVERY_MS);
  setTimeout(() => void runNotificationChecks(), 30_000).unref();
  timer.unref();
}

export function stopNotificationJobs() {
  if (timer) clearInterval(timer);
  timer = null;
}
