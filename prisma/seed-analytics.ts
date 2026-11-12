/**
 * Demo shopper activity for Admin → Analytics: 90 days of product views, carts,
 * watches and shares by guests and members, plus a purchase journey for every
 * seeded order (so sales and the shopper journey agree).
 *
 * Re-runnable: it replaces only its own rows (visitor ids starting "demo").
 * Runs at the end of `pnpm run db:seed`, or alone: `pnpm run db:seed:analytics`.
 * Never run it against a live store: it invents traffic.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { createPrisma } from "../src/db";

type Db = ReturnType<typeof createPrisma>;
type Row = { type: "VIEW" | "ADD_TO_CART" | "WATCH" | "SHARE" | "PURCHASE"; productId: string; userId: string | null; visitorId: string; quantity: number; createdAt: Date };

/** Small deterministic PRNG (mulberry32), so every seed looks the same. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedAnalytics(prisma: Db, { days = 90 } = {}) {
  const rand = rng(20261111);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const DAY = 86_400_000;
  const now = Date.now();

  await prisma.productEvent.deleteMany({ where: { visitorId: { startsWith: "demo" } } });

  const [products, members, orders] = await Promise.all([
    prisma.product.findMany({ where: { status: "ACTIVE" }, select: { id: true, soldCount: true, ratingAvg: true }, orderBy: { id: "asc" } }),
    prisma.user.findMany({ where: { role: "CUSTOMER" }, select: { id: true }, orderBy: { id: "asc" } }),
    prisma.order.findMany({ where: { status: { notIn: ["CANCELLED", "REFUNDED"] } }, select: { id: true, userId: true, placedAt: true, items: { select: { productId: true, quantity: true } } } }),
  ]);
  if (!products.length) return { events: 0 };

  // Popularity: a long tail (some products get most of the traffic), nudged by sales.
  // Appeal: how often a view turns into a cart. A few popular items get low appeal,
  // so "viewed a lot, rarely bought" has something to show.
  // Products people actually ordered get more traffic, so best sellers are also well viewed.
  const ordered = new Map<string, number>();
  for (const o of orders) for (const it of o.items) if (it.productId) ordered.set(it.productId, (ordered.get(it.productId) ?? 0) + it.quantity);
  const traits = products.map((p, i) => {
    const rank = (i * 7919) % products.length;
    const popularity = (0.02 + 1 / (1 + rank) ** 0.6) * (1 + Math.log1p(p.soldCount) / 6) * (1 + (ordered.get(p.id) ?? 0) / 3) + rand() * 0.02;
    const appeal = rand() < 0.12 ? 0.01 + rand() * 0.02 : 0.05 + rand() * 0.18;
    return { id: p.id, popularity, appeal, shareable: rand() < 0.3 };
  });
  const totalPop = traits.reduce((s, t) => s + t.popularity, 0);
  const weighted = () => {
    let r = rand() * totalPop;
    for (const t of traits) if ((r -= t.popularity) <= 0) return t;
    return traits[traits.length - 1]!;
  };

  const rows: Row[] = [];
  const at = (dayOffset: number, minute: number) => new Date(now - dayOffset * DAY + minute * 60_000);

  // Browsing sessions: traffic grows a little towards today (a store that's picking up).
  const visitors = 1400;
  for (let v = 0; v < visitors; v++) {
    const member = rand() < 0.3 && members.length ? pick(members).id : null;
    const visitorId = `demo${v.toString(36).padStart(6, "0")}${Math.floor(rand() * 1e9).toString(36)}`;
    const sessions = 1 + Math.floor(rand() ** 2 * 4);
    for (let s = 0; s < sessions; s++) {
      const day = Math.floor(days * rand() ** 1.25);
      let minute = Math.floor(rand() * 600) - 300;
      const seen = 1 + Math.floor(rand() ** 1.5 * 6);
      for (let k = 0; k < seen; k++) {
        const t = weighted();
        minute += 1 + Math.floor(rand() * 6);
        rows.push({ type: "VIEW", productId: t.id, userId: member, visitorId, quantity: 1, createdAt: at(day, minute) });
        if (rand() < t.appeal * (member ? 1.4 : 1)) rows.push({ type: "ADD_TO_CART", productId: t.id, userId: member, visitorId, quantity: rand() < 0.85 ? 1 : 2, createdAt: at(day, minute + 1) });
        if (rand() < (member ? 0.05 : 0.012)) rows.push({ type: "WATCH", productId: t.id, userId: member, visitorId, quantity: 1, createdAt: at(day, minute + 1) });
        if (t.shareable && rand() < 0.03) rows.push({ type: "SHARE", productId: t.id, userId: member, visitorId, quantity: 1, createdAt: at(day, minute + 2) });
      }
    }
  }

  // Every seeded order: the buyer viewed, carted and bought each line.
  orders.forEach((o, i) => {
    const visitorId = `demo-order-${i.toString(36)}`;
    const placed = o.placedAt.getTime();
    for (const item of o.items) {
      if (!item.productId) continue;
      const base = { productId: item.productId, userId: o.userId, visitorId };
      rows.push({ ...base, type: "VIEW", quantity: 1, createdAt: new Date(placed - 40 * 60_000) });
      rows.push({ ...base, type: "ADD_TO_CART", quantity: item.quantity, createdAt: new Date(placed - 25 * 60_000) });
      rows.push({ ...base, type: "PURCHASE", quantity: item.quantity, createdAt: o.placedAt });
    }
  });

  const live = rows.filter((r) => r.createdAt.getTime() <= now);
  for (let i = 0; i < live.length; i += 5000) await prisma.productEvent.createMany({ data: live.slice(i, i + 5000) });
  return { events: live.length };
}

// Standalone: `tsx prisma/seed-analytics.ts`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const prisma = createPrisma();
  seedAnalytics(prisma)
    .then((r) => console.log(`✔ Demo analytics: ${r.events.toLocaleString("en-US")} events`))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
