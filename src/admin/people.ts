import type { z } from "zod";
import { effectivePermissions, formatOrderNumber, isAdminRole, type customerListQuery, type Role } from "../core";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { HttpError, notFound } from "../lib/errors";

/** Orders that count toward a customer's spend. */
const COUNTED = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"] as const;

// ── Customers ────────────────────────────────────────────────────────────────

/**
 * Customers with order counts and spend. Aggregates are computed in SQL so
 * sorting by orders or spend works across pages.
 */
export async function listCustomers(q: z.infer<typeof customerListQuery>) {
  const where: Prisma.Sql[] = [Prisma.sql`u.role = 'CUSTOMER'`];
  if (q.q) where.push(Prisma.sql`(u.email ILIKE ${`%${q.q}%`} OR u.name ILIKE ${`%${q.q}%`})`);
  if (q.status === "active") where.push(Prisma.sql`u."isActive" = true`);
  if (q.status === "blocked") where.push(Prisma.sql`u."isActive" = false`);
  const whereSql = Prisma.join(where, " AND ");
  const dir = q.dir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const order =
    q.sort === "orders" ? Prisma.sql`order_count ${dir}, u."createdAt" DESC` : q.sort === "spent" ? Prisma.sql`spent ${dir}, u."createdAt" DESC` : q.sort === "name" ? Prisma.sql`lower(coalesce(u.name, u.email)) ${dir}` : Prisma.sql`u."createdAt" ${dir}`;
  const counted = Prisma.join(COUNTED.map((s) => Prisma.sql`${s}::"OrderStatus"`));
  const [rows, total] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; name: string | null; email: string; isActive: boolean; createdAt: Date; order_count: bigint; spent: bigint; last_order: Date | null }>>`
      SELECT u.id, u.name, u.email, u."isActive", u."createdAt",
             count(o.id) FILTER (WHERE o.status IN (${counted})) AS order_count,
             coalesce(sum(o."totalCents") FILTER (WHERE o.status IN (${counted})), 0) AS spent,
             max(o."placedAt") AS last_order
      FROM "User" u LEFT JOIN "Order" o ON o."userId" = u.id
      WHERE ${whereSql}
      GROUP BY u.id
      ORDER BY ${order}
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
    prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "User" u WHERE ${whereSql}`,
  ]);
  return {
    items: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, isActive: r.isActive, joinedAt: r.createdAt.toISOString(), orderCount: Number(r.order_count), spentCents: Number(r.spent), lastOrderAt: r.last_order?.toISOString() ?? null })),
    total: Number(total[0]?.n ?? 0),
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function readCustomer(id: string) {
  const u = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true,
      lastLoginAt: true,
      addresses: { orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] },
      orders: { orderBy: { placedAt: "desc" }, take: 50, select: { id: true, orderNo: true, status: true, totalCents: true, currency: true, placedAt: true, _count: { select: { items: true } } } },
      reviews: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, rating: true, title: true, status: true, createdAt: true, product: { select: { title: true, slug: true } } } },
      _count: { select: { watchlist: true } },
    },
  });
  if (!u) return null;
  const counted = u.orders.filter((o) => (COUNTED as readonly string[]).includes(o.status));
  const spent = counted.reduce((s, o) => s + o.totalCents, 0);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    joinedAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    stats: { orderCount: counted.length, spentCents: spent, averageCents: counted.length ? Math.round(spent / counted.length) : 0, watchlist: u._count.watchlist },
    addresses: u.addresses.map((a) => ({ id: a.id, fullName: a.fullName, line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postalCode, country: a.country, phone: a.phone, isDefault: a.isDefault })),
    orders: u.orders.map((o) => ({ id: o.id, number: formatOrderNumber(o.orderNo), status: o.status, totalCents: o.totalCents, currency: o.currency, itemCount: o._count.items, placedAt: o.placedAt.toISOString() })),
    reviews: u.reviews.map((r) => ({ id: r.id, rating: r.rating, title: r.title, status: r.status, createdAt: r.createdAt.toISOString(), product: r.product })),
  };
}

export async function updateCustomer(id: string, input: { name: string | null; isActive: boolean }, actorId: string | null) {
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, name: true, isActive: true, email: true } });
  if (!u) throw notFound("Customer");
  if (u.id === actorId && !input.isActive) throw new HttpError(409, "self_block", "You can't block your own account.");
  if (isAdminRole(u.role)) throw new HttpError(409, "is_admin", "This is a team member. Manage them under Team.");
  await prisma.user.update({ where: { id }, data: input });
  // Blocking signs them out everywhere: their sessions are checked against isActive on every request.
  if (!input.isActive) await prisma.session.deleteMany({ where: { userId: id } });
  return { before: { name: u.name, isActive: u.isActive }, email: u.email };
}

// ── Team (admin accounts) ────────────────────────────────────────────────────

export async function listTeam() {
  const rows = await prisma.user.findMany({
    where: { role: { in: ["ADMIN", "SUPER_ADMIN", "SELLER"] } },
    orderBy: [{ role: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true, email: true, role: true, permissions: true, isActive: true, lastLoginAt: true, createdAt: true },
  });
  return rows.map((u) => ({
    ...u,
    customPermissions: u.permissions.length > 0,
    permissions: [...effectivePermissions(u.role, u.permissions)],
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  }));
}

/** Finds a user by email to add to the team. */
export async function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, name: true, email: true, role: true } });
}

export async function setTeamMember(id: string, input: { role: Role; permissions: string[] }, actor: { id: string; role: Role }) {
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, permissions: true } });
  if (!u) throw notFound("User");
  if (u.id === actor.id) throw new HttpError(409, "self_change", "You can't change your own role or permissions. Ask another super admin.");
  // Only super admins can create or change super admins.
  if ((input.role === "SUPER_ADMIN" || u.role === "SUPER_ADMIN") && actor.role !== "SUPER_ADMIN") throw new HttpError(403, "forbidden", "Only a super admin can change super admins.");
  if (u.role === "SUPER_ADMIN" && input.role !== "SUPER_ADMIN") {
    const supers = await prisma.user.count({ where: { role: "SUPER_ADMIN", isActive: true } });
    if (supers <= 1) throw new HttpError(409, "last_super_admin", "Keep at least one super admin.");
  }
  const permissions = input.role === "SUPER_ADMIN" || input.role === "CUSTOMER" ? [] : input.permissions;
  await prisma.user.update({ where: { id }, data: { role: input.role, permissions } });
  return { before: { role: u.role, permissions: u.permissions }, after: { role: input.role, permissions }, email: u.email };
}
