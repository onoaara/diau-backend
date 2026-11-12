import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { analyticsOverview, analyticsQuery, productAnalytics } from "../admin/analytics";
import {
  auditListQuery,
  contentPageInputSchema,
  couponInputSchema,
  customerListQuery,
  customerUpdateSchema,
  markPaidSchema,
  orderListQuery,
  orderNoteSchema,
  orderStatusInputSchema,
  promotionInputSchema,
  refundInputSchema,
  reviewListQuery,
  reviewModerationSchema,
  TAGS,
  teamMemberSchema,
  trackingInputSchema,
} from "../core";
import {
  dashboardStats,
  deleteContentPage,
  deleteCoupon,
  deletePromotion,
  listAudit,
  listCoupons,
  listPromotions,
  listReviews,
  moderateReviews,
  readContentPage,
  readPromotion,
  saveContentPage,
  saveCoupon,
  savePromotion,
} from "../admin/marketing";
import { addOrderNote, changeOrderStatus, exportOrdersCsv, listOrders, markPaymentPaid, readOrderForAdmin, refundOrder, updateTracking } from "../admin/orders";
import { findUserByEmail, listCustomers, listTeam, readCustomer, setTeamMember, updateCustomer } from "../admin/people";
import { audit } from "../lib/audit";
import { notFound } from "../lib/errors";
import { revalidateFrontend } from "../lib/revalidate";
import { requirePermission } from "../plugins/auth";
import { onOrderStatusChanged, onPaymentReceived, onRefund, onTrackingAdded } from "../realtime/events";

const idParam = z.object({ id: z.string().regex(/^[a-z0-9]{10,40}$/i) });
const ok = z.object({ ok: z.literal(true) });
const who = (req: FastifyRequest) => ({ actorId: req.authUser?.id ?? null, ip: req.ip });

/** Admin: orders, payments & refunds, customers, team, promotions, coupons, reviews, content pages, audit log, dashboard. */
export const adminSalesRoutes: FastifyPluginAsyncZod = async (app) => {
  // ── Analytics ──────────────────────────────────────────────────────────────
  app.get("/admin/analytics", { preHandler: requirePermission("dashboard:read"), schema: { tags: ["admin"], querystring: analyticsQuery } }, async (req) => analyticsOverview(req.query));
  app.get(
    "/admin/analytics/products/:id",
    {
      preHandler: requirePermission("dashboard:read"),
      schema: { tags: ["admin"], params: z.object({ id: z.string().regex(/^[a-z0-9]{10,40}$/i) }), querystring: z.object({ days: analyticsQuery.shape.days }) },
    },
    async (req) => productAnalytics(req.params.id, req.query.days),
  );

  // ── Dashboard ──────────────────────────────────────────────────────────────
  app.get("/admin/dashboard", { preHandler: requirePermission("dashboard:read"), schema: { tags: ["admin"], querystring: z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).default(30) }) } }, async (req) =>
    dashboardStats(req.query.days),
  );

  // ── Orders ─────────────────────────────────────────────────────────────────
  app.get("/admin/orders", { preHandler: requirePermission("orders:read"), schema: { tags: ["admin"], querystring: orderListQuery } }, async (req) => listOrders(req.query));

  app.get("/admin/orders/export", { preHandler: requirePermission("orders:read"), schema: { tags: ["admin"], querystring: orderListQuery } }, async (req, reply) => {
    const csv = await exportOrdersCsv(req.query);
    await audit({ ...who(req), action: "order.export", entity: "Order", summary: "Exported orders to CSV" });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="diau-orders-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(`﻿${csv}`);
  });

  app.get("/admin/orders/:id", { preHandler: requirePermission("orders:read"), schema: { tags: ["admin"], params: idParam } }, async (req) => {
    const o = await readOrderForAdmin(req.params.id);
    if (!o) throw notFound("Order");
    return o;
  });

  app.post("/admin/orders/:id/status", { preHandler: requirePermission("orders:write"), schema: { tags: ["admin"], params: idParam, body: orderStatusInputSchema, response: { 200: ok } } }, async (req) => {
    const r = await changeOrderStatus(req.params.id, req.body, req.authUser!.id);
    await audit({ ...who(req), action: "order.status", entity: "Order", entityId: req.params.id, summary: `${r.number}: ${r.from.toLowerCase()} → ${r.to.toLowerCase()}${r.restocked ? " (restocked)" : ""}`, before: { status: r.from }, after: { status: r.to } });
    if (r.restocked) revalidateFrontend([TAGS.products]);
    void onOrderStatusChanged(req.params.id, r.to);
    return { ok: true as const };
  });

  app.post(
    "/admin/orders/:id/payments/:paymentId/paid",
    { preHandler: requirePermission("orders:write"), schema: { tags: ["admin"], params: idParam.extend({ paymentId: z.string().regex(/^[a-z0-9]{10,40}$/i) }), body: markPaidSchema, response: { 200: ok } } },
    async (req) => {
      const r = await markPaymentPaid(req.params.id, req.params.paymentId, req.body.reference, req.authUser!.id);
      await audit({ ...who(req), action: "order.payment_received", entity: "Order", entityId: req.params.id, summary: `${r.number}: payment of ${(r.amountCents / 100).toFixed(2)} marked received` });
      void onPaymentReceived(req.params.id);
      return { ok: true as const };
    },
  );

  app.post("/admin/orders/:id/refund", { preHandler: requirePermission("refunds:write"), schema: { tags: ["admin"], params: idParam, body: refundInputSchema, response: { 200: ok } } }, async (req) => {
    const r = await refundOrder(req.params.id, req.body, req.authUser!.id);
    await audit({ ...who(req), action: "order.refund", entity: "Order", entityId: req.params.id, summary: `${r.number}: refunded ${(r.amountCents / 100).toFixed(2)}${r.full ? " (full)" : ""}${r.restocked ? ", restocked" : ""}`, after: { amountCents: r.amountCents, reason: req.body.reason } });
    if (r.restocked) revalidateFrontend([TAGS.products]);
    void onRefund(req.params.id, r.amountCents);
    return { ok: true as const };
  });

  app.post("/admin/orders/:id/notes", { preHandler: requirePermission("orders:write"), schema: { tags: ["admin"], params: idParam, body: orderNoteSchema, response: { 200: ok } } }, async (req) => {
    const r = await addOrderNote(req.params.id, req.body.note, req.authUser!.id);
    await audit({ ...who(req), action: "order.note", entity: "Order", entityId: req.params.id, summary: `${r.number}: added a note` });
    return { ok: true as const };
  });

  app.put("/admin/orders/:id/tracking", { preHandler: requirePermission("orders:write"), schema: { tags: ["admin"], params: idParam, body: trackingInputSchema, response: { 200: ok } } }, async (req) => {
    const r = await updateTracking(req.params.id, req.body, req.authUser!.id);
    await audit({ ...who(req), action: "order.tracking", entity: "Order", entityId: req.params.id, summary: `${r.number}: tracking updated`, after: req.body });
    if (req.body.trackingNumber) void onTrackingAdded(req.params.id);
    return { ok: true as const };
  });

  // ── Customers ──────────────────────────────────────────────────────────────
  app.get("/admin/customers", { preHandler: requirePermission("customers:read"), schema: { tags: ["admin"], querystring: customerListQuery } }, async (req) => listCustomers(req.query));

  app.get("/admin/customers/:id", { preHandler: requirePermission("customers:read"), schema: { tags: ["admin"], params: idParam } }, async (req) => {
    const c = await readCustomer(req.params.id);
    if (!c) throw notFound("Customer");
    return c;
  });

  app.put("/admin/customers/:id", { preHandler: requirePermission("customers:write"), schema: { tags: ["admin"], params: idParam, body: customerUpdateSchema, response: { 200: ok } } }, async (req) => {
    const r = await updateCustomer(req.params.id, req.body, req.authUser!.id);
    const verb = r.before.isActive && !req.body.isActive ? "Blocked" : !r.before.isActive && req.body.isActive ? "Unblocked" : "Updated";
    await audit({ ...who(req), action: "customer.update", entity: "User", entityId: req.params.id, summary: `${verb} customer ${r.email}`, before: r.before, after: req.body });
    return { ok: true as const };
  });

  // ── Team ───────────────────────────────────────────────────────────────────
  app.get("/admin/team", { preHandler: requirePermission("users:write"), schema: { tags: ["admin"] } }, async () => ({ items: await listTeam() }));

  app.get("/admin/team/lookup", { preHandler: requirePermission("users:write"), schema: { tags: ["admin"], querystring: z.object({ email: z.email() }) } }, async (req) => ({ user: await findUserByEmail(req.query.email) }));

  app.put("/admin/team/:id", { preHandler: requirePermission("users:write"), schema: { tags: ["admin"], params: idParam, body: teamMemberSchema, response: { 200: ok } } }, async (req) => {
    const r = await setTeamMember(req.params.id, req.body, req.authUser!);
    await audit({ ...who(req), action: "user.role", entity: "User", entityId: req.params.id, summary: `Set ${r.email} to ${req.body.role.toLowerCase().replace("_", " ")}`, before: r.before, after: r.after });
    return { ok: true as const };
  });

  // ── Promotions ─────────────────────────────────────────────────────────────
  const promo = requirePermission("promotions:write");
  const promoTags = [TAGS.promotions, TAGS.products, TAGS.pages];
  app.get("/admin/promotions", { preHandler: promo, schema: { tags: ["admin"] } }, async () => ({ items: await listPromotions() }));
  app.get("/admin/promotions/:id", { preHandler: promo, schema: { tags: ["admin"], params: idParam } }, async (req) => {
    const p = await readPromotion(req.params.id);
    if (!p) throw notFound("Promotion");
    return p;
  });
  app.post("/admin/promotions", { preHandler: promo, schema: { tags: ["admin"], body: promotionInputSchema } }, async (req, reply) => {
    const p = await savePromotion(null, req.body);
    await audit({ ...who(req), action: "promotion.create", entity: "Promotion", entityId: p.id, summary: `Created promotion “${p.name}”`, after: req.body });
    revalidateFrontend(promoTags);
    return reply.code(201).send({ id: p.id });
  });
  app.put("/admin/promotions/:id", { preHandler: promo, schema: { tags: ["admin"], params: idParam, body: promotionInputSchema } }, async (req) => {
    const p = await savePromotion(req.params.id, req.body);
    await audit({ ...who(req), action: "promotion.update", entity: "Promotion", entityId: p.id, summary: `Updated promotion “${p.name}”`, after: req.body });
    revalidateFrontend(promoTags);
    return { id: p.id };
  });
  app.delete("/admin/promotions/:id", { preHandler: promo, schema: { tags: ["admin"], params: idParam, response: { 200: ok } } }, async (req) => {
    const p = await deletePromotion(req.params.id);
    await audit({ ...who(req), action: "promotion.delete", entity: "Promotion", entityId: p.id, summary: `Deleted promotion “${p.name}”` });
    revalidateFrontend(promoTags);
    return { ok: true as const };
  });

  // ── Coupons ────────────────────────────────────────────────────────────────
  app.get("/admin/coupons", { preHandler: promo, schema: { tags: ["admin"] } }, async () => ({ items: await listCoupons() }));
  app.post("/admin/coupons", { preHandler: promo, schema: { tags: ["admin"], body: couponInputSchema } }, async (req, reply) => {
    const c = await saveCoupon(null, req.body);
    await audit({ ...who(req), action: "coupon.create", entity: "Coupon", entityId: c.id, summary: `Created coupon ${c.code}`, after: req.body });
    return reply.code(201).send({ id: c.id });
  });
  app.put("/admin/coupons/:id", { preHandler: promo, schema: { tags: ["admin"], params: idParam, body: couponInputSchema } }, async (req) => {
    const c = await saveCoupon(req.params.id, req.body);
    await audit({ ...who(req), action: "coupon.update", entity: "Coupon", entityId: c.id, summary: `Updated coupon ${c.code}`, before: c.before as Record<string, unknown> | null, after: req.body });
    return { id: c.id };
  });
  app.delete("/admin/coupons/:id", { preHandler: promo, schema: { tags: ["admin"], params: idParam, response: { 200: ok } } }, async (req) => {
    const c = await deleteCoupon(req.params.id);
    await audit({ ...who(req), action: "coupon.delete", entity: "Coupon", entityId: c.id, summary: `Deleted coupon ${c.code}` });
    return { ok: true as const };
  });

  // ── Reviews ────────────────────────────────────────────────────────────────
  app.get("/admin/reviews", { preHandler: requirePermission("reviews:write"), schema: { tags: ["admin"], querystring: reviewListQuery } }, async (req) => listReviews(req.query));
  app.post("/admin/reviews/moderate", { preHandler: requirePermission("reviews:write"), schema: { tags: ["admin"], body: reviewModerationSchema } }, async (req) => {
    const r = await moderateReviews(req.body.ids, req.body.action);
    const verb = { approve: "Approved", reject: "Rejected", delete: "Deleted" }[req.body.action];
    await audit({ ...who(req), action: `review.${req.body.action}`, entity: "Review", entityId: req.body.ids.length === 1 ? req.body.ids[0] : null, summary: `${verb} ${r.count} ${r.count === 1 ? "review" : "reviews"}` });
    revalidateFrontend([TAGS.products, ...r.slugs.map(TAGS.product)]);
    return { count: r.count, slugs: r.slugs };
  });

  // ── Content & landing pages ────────────────────────────────────────────────
  const storefront = requirePermission("storefront:write");
  app.get("/admin/content-pages/:id", { preHandler: storefront, schema: { tags: ["admin"], params: idParam } }, async (req) => {
    const p = await readContentPage(req.params.id);
    if (!p) throw notFound("Page");
    return p;
  });
  app.post("/admin/content-pages", { preHandler: storefront, schema: { tags: ["admin"], body: contentPageInputSchema } }, async (req, reply) => {
    const p = await saveContentPage(null, req.body);
    await audit({ ...who(req), action: "page.create", entity: "Page", entityId: p.id, summary: `Created page /${p.slug}` });
    revalidateFrontend([TAGS.pages, TAGS.page(p.slug)]);
    return reply.code(201).send({ id: p.id, slug: p.slug });
  });
  app.put("/admin/content-pages/:id", { preHandler: storefront, schema: { tags: ["admin"], params: idParam, body: contentPageInputSchema } }, async (req) => {
    const p = await saveContentPage(req.params.id, req.body);
    await audit({ ...who(req), action: "page.update", entity: "Page", entityId: p.id, summary: `Updated page /${p.slug}${p.oldSlug && p.oldSlug !== p.slug ? ` (was /${p.oldSlug})` : ""}` });
    revalidateFrontend([TAGS.pages, TAGS.page(p.slug), ...(p.oldSlug ? [TAGS.page(p.oldSlug)] : [])]);
    return { id: p.id, slug: p.slug };
  });
  app.delete("/admin/content-pages/:id", { preHandler: storefront, schema: { tags: ["admin"], params: idParam, response: { 200: ok } } }, async (req) => {
    const p = await deleteContentPage(req.params.id);
    await audit({ ...who(req), action: "page.delete", entity: "Page", entityId: p.id, summary: `Deleted page /${p.slug}` });
    revalidateFrontend([TAGS.pages, TAGS.page(p.slug)]);
    return { ok: true as const };
  });

  // ── Audit log ──────────────────────────────────────────────────────────────
  app.get("/admin/audit", { preHandler: requirePermission("audit:read"), schema: { tags: ["admin"], querystring: auditListQuery } }, async (req) => listAudit(req.query));
};
