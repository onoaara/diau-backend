import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { ProductEventType } from "../generated/prisma/client";
import { prisma } from "../db";

/**
 * Product events for Admin → Analytics (see the ProductEvent model).
 *
 * Recording never fails the shopper's request: errors are logged and dropped.
 * Staff accounts are skipped, so the team's own browsing doesn't count.
 */

/** Header the frontend uses to forward the shopper's random visitor id (cookie). */
export const VISITOR_HEADER = "x-diau-visitor";
const VISITOR_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** A visitor's repeat views of one product within this window count once. */
export const VIEW_DEDUPE_MS = 30 * 60_000;
const STAFF_ROLES = new Set(["ADMIN", "SUPER_ADMIN", "SELLER"]);

export type Actor = { userId: string | null; visitorId: string | null; staff: boolean };

/** Who is acting: the signed-in user (from the token) and the browser's visitor id. */
export function actorFrom(req: FastifyRequest): Actor {
  const raw = req.headers[VISITOR_HEADER];
  const visitorId = typeof raw === "string" && VISITOR_ID.test(raw) ? raw : null;
  return { userId: req.auth?.userId ?? null, visitorId, staff: !!req.auth && STAFF_ROLES.has(req.auth.role) };
}

export type EventInput = { type: ProductEventType; productId: string; quantity?: number };

/** Records events for one actor. Fire-and-forget: call without awaiting. */
export async function recordEvents(actor: Actor, events: EventInput[], log?: FastifyBaseLogger): Promise<void> {
  if (actor.staff || !events.length) return;
  try {
    await prisma.productEvent.createMany({
      data: events.map((e) => ({ type: e.type, productId: e.productId, quantity: Math.max(1, Math.min(e.quantity ?? 1, 999)), userId: actor.userId, visitorId: actor.visitorId })),
    });
  } catch (err) {
    log?.warn({ err }, "analytics event not recorded");
  }
}

/**
 * Records a product view unless this visitor (or member) already viewed the
 * product in the last 30 minutes. Returns whether a row was written.
 */
export async function recordView(actor: Actor, productId: string, log?: FastifyBaseLogger, now = new Date()): Promise<boolean> {
  if (actor.staff || (!actor.userId && !actor.visitorId)) return false;
  const since = new Date(now.getTime() - VIEW_DEDUPE_MS);
  const who = actor.visitorId ? { visitorId: actor.visitorId } : { userId: actor.userId };
  try {
    const seen = await prisma.productEvent.findFirst({ where: { type: "VIEW", productId, ...who, createdAt: { gte: since } }, select: { id: true } });
    if (seen) return false;
    await prisma.productEvent.create({ data: { type: "VIEW", productId, userId: actor.userId, visitorId: actor.visitorId, createdAt: now } });
    return true;
  } catch (err) {
    log?.warn({ err }, "analytics view not recorded");
    return false;
  }
}
