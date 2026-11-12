import { z } from "zod";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";

/*
 * Admin → Analytics. Everything is computed in Postgres for one window (the last
 * N days, UTC) plus the window before it for comparison.
 *
 * - Behaviour (views, carts, watches, shares, the journey) comes from ProductEvent.
 * - Sales (units, revenue, orders) come from orders, like the dashboard: orders
 *   that aren't cancelled or refunded, by the day they were placed.
 * - "Segment" splits signed-in members from guests: for events by the event's
 *   user, for sales by the order's account.
 * - A visitor is the browser's visitor id (falling back to the account), so a
 *   guest who signs in halfway through stays one visitor in the journey.
 */

export const analyticsQuery = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).default(30),
  segment: z.enum(["all", "members", "guests"]).default("all"),
  sort: z.enum(["views", "visitors", "carts", "watches", "shares", "units", "revenueCents", "cartRate", "buyRate", "trend"]).default("units"),
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuery>;
export type Segment = AnalyticsQuery["segment"];

const COUNTED = Prisma.sql`('PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED')`;
const PAGE_SIZE = 25;
/** Rates need enough visitors to mean something. */
const MIN_VISITORS_FOR_RATES = 5;
/** The insight lists are recommendations, so they ask for more. */
const MIN_VISITORS_FOR_INSIGHTS = 10;
const DAY = 86_400_000;

export function windowFor(days: number, now = new Date()) {
  const startToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(startToday - (days - 1) * DAY);
  return { from, prevFrom: new Date(from.getTime() - days * DAY) };
}

const eventSegment = (s: Segment, alias = "") =>
  s === "members" ? Prisma.sql`AND ${Prisma.raw(alias)}"userId" IS NOT NULL` : s === "guests" ? Prisma.sql`AND ${Prisma.raw(alias)}"userId" IS NULL` : Prisma.empty;
const orderSegment = (s: Segment) => (s === "members" ? Prisma.sql`AND o."userId" IS NOT NULL` : s === "guests" ? Prisma.sql`AND o."userId" IS NULL` : Prisma.empty);

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
const rate = (part: number, whole: number) => (whole >= MIN_VISITORS_FOR_RATES ? Math.min(1, part / whole) : null);

// ── Per-product rows ─────────────────────────────────────────────────────────

type EventAgg = { productId: string; views: bigint; memberViews: bigint; visitors: bigint; carts: bigint; carters: bigint; watches: bigint; guestWatches: bigint; shares: bigint; buyers: bigint; prevViews: bigint };
type SalesAgg = { productId: string; units: bigint; memberUnits: bigint; revenue: bigint; orders: bigint };

export type ProductRow = {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  status: string;
  views: number;
  memberViews: number;
  visitors: number;
  carts: number;
  carters: number;
  /** Visitors who bought it (from the journey events). */
  buyers: number;
  watches: number;
  /** Guests who pressed Watch and were asked to sign in. */
  guestWatches: number;
  watchersNow: number;
  shares: number;
  units: number;
  memberUnits: number;
  revenueCents: number;
  orders: number;
  /** Share of visitors who added it to a cart (null below 5 visitors). */
  cartRate: number | null;
  /** Share of visitors who bought it (null below 5 visitors). */
  buyRate: number | null;
  /** Views vs the previous window, as a fraction (null when there were none before). */
  trend: number | null;
  prevViews: number;
};

async function productRows(days: number, segment: Segment, productId?: string): Promise<ProductRow[]> {
  const { from, prevFrom } = windowFor(days);
  const one = productId ? Prisma.sql`AND "productId" = ${productId}` : Prisma.empty;
  const oneItem = productId ? Prisma.sql`AND i."productId" = ${productId}` : Prisma.empty;
  const [events, sales] = await Promise.all([
    prisma.$queryRaw<EventAgg[]>`
      SELECT "productId",
        count(*) FILTER (WHERE type = 'VIEW' AND "createdAt" >= ${from}) AS views,
        count(*) FILTER (WHERE type = 'VIEW' AND "createdAt" >= ${from} AND "userId" IS NOT NULL) AS "memberViews",
        count(DISTINCT coalesce("visitorId", "userId")) FILTER (WHERE type = 'VIEW' AND "createdAt" >= ${from}) AS visitors,
        coalesce(sum(quantity) FILTER (WHERE type = 'ADD_TO_CART' AND "createdAt" >= ${from}), 0) AS carts,
        count(DISTINCT coalesce("visitorId", "userId")) FILTER (WHERE type = 'ADD_TO_CART' AND "createdAt" >= ${from}) AS carters,
        count(*) FILTER (WHERE type = 'WATCH' AND "createdAt" >= ${from} AND "userId" IS NOT NULL) AS watches,
        count(*) FILTER (WHERE type = 'WATCH' AND "createdAt" >= ${from} AND "userId" IS NULL) AS "guestWatches",
        count(*) FILTER (WHERE type = 'SHARE' AND "createdAt" >= ${from}) AS shares,
        count(DISTINCT coalesce("visitorId", "userId")) FILTER (WHERE type = 'PURCHASE' AND "createdAt" >= ${from}) AS buyers,
        count(*) FILTER (WHERE type = 'VIEW' AND "createdAt" < ${from}) AS "prevViews"
      FROM "ProductEvent"
      WHERE "createdAt" >= ${prevFrom} ${eventSegment(segment)} ${one}
      GROUP BY "productId"`,
    prisma.$queryRaw<SalesAgg[]>`
      SELECT i."productId",
        sum(i.quantity) AS units,
        coalesce(sum(i.quantity) FILTER (WHERE o."userId" IS NOT NULL), 0) AS "memberUnits",
        sum(i."totalCents") AS revenue,
        count(DISTINCT i."orderId") AS orders
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
      WHERE i."productId" IS NOT NULL AND o."placedAt" >= ${from} AND o.status::text IN ${COUNTED} ${orderSegment(segment)} ${oneItem}
      GROUP BY i."productId"`,
  ]);

  const ids = [...new Set([...events.map((e) => e.productId), ...sales.map((s) => s.productId), ...(productId ? [productId] : [])])];
  if (!ids.length) return [];
  const [products, watchers] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, slug: true, status: true, images: { orderBy: { position: "asc" }, take: 1, select: { media: { select: { url: true } } } } } }),
    // Watchers are members by definition: nothing to show for guests.
    segment === "guests" ? Promise.resolve([]) : prisma.watchlistItem.groupBy({ by: ["productId"], where: { productId: { in: ids } }, _count: true }),
  ]);
  const ev = new Map(events.map((e) => [e.productId, e]));
  const sa = new Map(sales.map((s) => [s.productId, s]));
  const wa = new Map(watchers.map((w) => [w.productId, w._count]));

  return products.map((p) => {
    const e = ev.get(p.id);
    const s = sa.get(p.id);
    const visitors = n(e?.visitors);
    const views = n(e?.views);
    const prevViews = n(e?.prevViews);
    return {
      productId: p.id,
      title: p.title,
      slug: p.slug,
      imageUrl: p.images[0]?.media.url ?? null,
      status: p.status,
      views,
      memberViews: n(e?.memberViews),
      visitors,
      carts: n(e?.carts),
      carters: n(e?.carters),
      buyers: n(e?.buyers),
      watches: n(e?.watches),
      guestWatches: n(e?.guestWatches),
      watchersNow: wa.get(p.id) ?? 0,
      shares: n(e?.shares),
      units: n(s?.units),
      memberUnits: n(s?.memberUnits),
      revenueCents: n(s?.revenue),
      orders: n(s?.orders),
      cartRate: rate(n(e?.carters), visitors),
      buyRate: rate(n(e?.buyers), visitors),
      trend: prevViews ? (views - prevViews) / prevViews : null,
      prevViews,
    };
  });
}

const val = (r: ProductRow, key: keyof ProductRow) => (r[key] as number | null) ?? -Infinity;
/** Highest first; nulls last; ties by views, then title. */
const by = (key: keyof ProductRow) => (a: ProductRow, b: ProductRow) => {
  const d = val(b, key) - val(a, key);
  return d && !Number.isNaN(d) ? d : b.views - a.views || a.title.localeCompare(b.title);
};

const top = (rows: ProductRow[], key: keyof ProductRow, limit = 5) => rows.filter((r) => ((r[key] as number | null) ?? 0) > 0).sort(by(key)).slice(0, limit);

// ── Overview ─────────────────────────────────────────────────────────────────

type TotalsAgg = { current: boolean; type: string; events: bigint; units: bigint; actors: bigint };
type JourneyAgg = { member: boolean; viewed: bigint; carted: bigint; purchased: bigint };
type DailyAgg = { day: Date; member: boolean; views: bigint; carts: bigint };
type SalesTotals = { current: boolean; units: bigint; revenue: bigint; orders: bigint; buyers: bigint };

export async function analyticsOverview({ days, segment, sort, q, page }: AnalyticsQuery) {
  const { from, prevFrom } = windowFor(days);
  const [totals, journey, daily, sales, rows] = await Promise.all([
    prisma.$queryRaw<TotalsAgg[]>`
      SELECT ("createdAt" >= ${from}) AS current, type::text AS type, count(*) AS events, coalesce(sum(quantity), 0) AS units,
        count(DISTINCT coalesce("visitorId", "userId")) AS actors
      FROM "ProductEvent" WHERE "createdAt" >= ${prevFrom} ${eventSegment(segment)}
      GROUP BY 1, 2`,
    // Journey per visitor: of those who viewed a product, who added to a cart, and who then bought.
    prisma.$queryRaw<JourneyAgg[]>`
      WITH v AS (
        SELECT coalesce("visitorId", "userId") AS k, bool_or("userId" IS NOT NULL) AS member,
          bool_or(type = 'VIEW') AS viewed, bool_or(type = 'ADD_TO_CART') AS carted, bool_or(type = 'PURCHASE') AS purchased
        FROM "ProductEvent" WHERE "createdAt" >= ${from} AND coalesce("visitorId", "userId") IS NOT NULL
        GROUP BY 1
      )
      SELECT member, count(*) FILTER (WHERE viewed) AS viewed, count(*) FILTER (WHERE viewed AND carted) AS carted,
        count(*) FILTER (WHERE viewed AND carted AND purchased) AS purchased
      FROM v GROUP BY member`,
    prisma.$queryRaw<DailyAgg[]>`
      SELECT date_trunc('day', "createdAt" AT TIME ZONE 'UTC') AS day, ("userId" IS NOT NULL) AS member,
        count(*) FILTER (WHERE type = 'VIEW') AS views, coalesce(sum(quantity) FILTER (WHERE type = 'ADD_TO_CART'), 0) AS carts
      FROM "ProductEvent" WHERE "createdAt" >= ${from} ${eventSegment(segment)}
      GROUP BY 1, 2`,
    prisma.$queryRaw<SalesTotals[]>`
      SELECT (o."placedAt" >= ${from}) AS current, coalesce(sum(i.quantity), 0) AS units, coalesce(sum(i."totalCents"), 0) AS revenue,
        count(DISTINCT o.id) AS orders, count(DISTINCT coalesce(o."userId", o.email)) AS buyers
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
      WHERE o."placedAt" >= ${prevFrom} AND o.status::text IN ${COUNTED} ${orderSegment(segment)}
      GROUP BY 1`,
    productRows(days, segment),
  ]);

  const total = (type: string, current: boolean, field: "events" | "units" | "actors" = "events") => n(totals.find((t) => t.type === type && t.current === current)?.[field]);
  const sale = (current: boolean) => sales.find((s) => s.current === current);
  const kpi = (now: number, previous: number) => ({ value: now, previous });

  const stages = (member: boolean | null) => {
    const rs = journey.filter((j) => member === null || j.member === member);
    return { viewed: rs.reduce((a, r) => a + n(r.viewed), 0), carted: rs.reduce((a, r) => a + n(r.carted), 0), purchased: rs.reduce((a, r) => a + n(r.purchased), 0) };
  };

  const byDay = new Map<string, { members: number; guests: number; carts: number }>();
  for (const d of daily) {
    const key = d.day.toISOString().slice(0, 10);
    const cur = byDay.get(key) ?? { members: 0, guests: 0, carts: 0 };
    if (d.member) cur.members += n(d.views);
    else cur.guests += n(d.views);
    cur.carts += n(d.carts);
    byDay.set(key, cur);
  }
  const series = Array.from({ length: days }, (_, i) => {
    const date = new Date(from.getTime() + i * DAY).toISOString().slice(0, 10);
    return { date, ...(byDay.get(date) ?? { members: 0, guests: 0, carts: 0 }) };
  });

  // Table: search, sort, page.
  const needle = q.toLowerCase();
  const filtered = (needle ? rows.filter((r) => r.title.toLowerCase().includes(needle)) : rows).sort(by(sort));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);

  const withRates = rows.filter((r) => r.visitors >= MIN_VISITORS_FOR_INSIGHTS);
  return {
    days,
    segment,
    from: from.toISOString(),
    tracked: totals.some((t) => t.current),
    kpis: {
      views: kpi(total("VIEW", true), total("VIEW", false)),
      visitors: kpi(total("VIEW", true, "actors"), total("VIEW", false, "actors")),
      addToCart: kpi(total("ADD_TO_CART", true, "units"), total("ADD_TO_CART", false, "units")),
      watches: kpi(total("WATCH", true), total("WATCH", false)),
      shares: kpi(total("SHARE", true), total("SHARE", false)),
      units: kpi(n(sale(true)?.units), n(sale(false)?.units)),
      revenueCents: kpi(n(sale(true)?.revenue), n(sale(false)?.revenue)),
      orders: kpi(n(sale(true)?.orders), n(sale(false)?.orders)),
    },
    journey: { all: stages(null), members: stages(true), guests: stages(false) },
    series,
    leaders: {
      bestSellers: top(rows, "units"),
      mostViewed: top(rows, "views"),
      mostCarted: top(rows, "carts"),
      mostWatched: [...rows].filter((r) => r.watches || r.watchersNow || r.guestWatches).sort((a, b) => b.watches + b.guestWatches - (a.watches + a.guestWatches) || b.watchersNow - a.watchersNow).slice(0, 5),
      mostShared: top(rows, "shares"),
    },
    insights: {
      // Lots of visitors, few buyers: price, photos or description may be holding it back.
      browsedNotBought: withRates.filter((r) => (r.buyRate ?? 0) < 0.02).sort((a, b) => b.visitors - a.visitors).slice(0, 5),
      // Added to carts but not bought: worth a reminder or a promotion.
      leftInCarts: rows
        .map((r) => ({ ...r, abandoned: Math.max(0, r.carters - r.buyers) }))
        .filter((r) => r.abandoned > 0)
        .sort((a, b) => b.abandoned - a.abandoned)
        .slice(0, 5),
      bestConverters: withRates.filter((r) => (r.buyRate ?? 0) > 0).sort(by("buyRate")).slice(0, 5),
      // Growing interest: at least 10 views now and 3 before, so one extra view isn't "+900%".
      trending: rows.filter((r) => r.views >= 10 && r.prevViews >= 3 && r.trend !== null && r.trend > 0).sort(by("trend")).slice(0, 5),
    },
    table: { rows: filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), total: filtered.length, page: current, pageSize: PAGE_SIZE, sort, q },
  };
}

// ── One product (product editor panel) ──────────────────────────────────────

export async function productAnalytics(productId: string, days: number) {
  const { from } = windowFor(days);
  const [[row], daily] = await Promise.all([
    productRows(days, "all", productId),
    prisma.$queryRaw<Array<{ day: Date; member: boolean; views: bigint }>>`
      SELECT date_trunc('day', "createdAt" AT TIME ZONE 'UTC') AS day, ("userId" IS NOT NULL) AS member, count(*) AS views
      FROM "ProductEvent" WHERE "productId" = ${productId} AND type = 'VIEW' AND "createdAt" >= ${from}
      GROUP BY 1, 2`,
  ]);
  const byDay = new Map<string, { members: number; guests: number }>();
  for (const d of daily) {
    const key = d.day.toISOString().slice(0, 10);
    const cur = byDay.get(key) ?? { members: 0, guests: 0 };
    if (d.member) cur.members += n(d.views);
    else cur.guests += n(d.views);
    byDay.set(key, cur);
  }
  return {
    days,
    product: row ?? null,
    series: Array.from({ length: days }, (_, i) => {
      const date = new Date(from.getTime() + i * DAY).toISOString().slice(0, 10);
      return { date, ...(byDay.get(date) ?? { members: 0, guests: 0 }) };
    }),
  };
}
