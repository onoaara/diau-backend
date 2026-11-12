import { z } from "zod";

/*
 * Notification types and settings (DESIGN.md §5.22), shared by the API and the web app.
 * Shoppers get the first four; admins also get the `admin_*` ones their permissions cover.
 */

export const SHOPPER_NOTIFICATION_TYPES = ["order_update", "watchlist_deal", "cart_reminder", "new_deal"] as const;
export const ADMIN_NOTIFICATION_TYPES = ["admin_order", "admin_review", "admin_low_stock", "admin_customer"] as const;
export const NOTIFICATION_TYPES = [...SHOPPER_NOTIFICATION_TYPES, ...ADMIN_NOTIFICATION_TYPES] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Off unless the person turns it on: everything else is on by default. */
export const OPT_IN_TYPES: readonly NotificationType[] = ["new_deal"];

/** Which admin permission a person needs to receive each admin type. */
export const ADMIN_TYPE_PERMISSION: Record<(typeof ADMIN_NOTIFICATION_TYPES)[number], string> = {
  admin_order: "orders:read",
  admin_review: "reviews:write",
  admin_low_stock: "products:read",
  admin_customer: "customers:read",
};

export const notificationPrefsSchema = z.object({
  /** Types switched on, beyond the defaults (only opt-in types matter here). */
  on: z.array(z.enum(NOTIFICATION_TYPES)).default([]),
  /** Types switched off. */
  off: z.array(z.enum(NOTIFICATION_TYPES)).default([]),
  /** Play a sound with in-app notifications. */
  sound: z.boolean().default(true),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export function readPrefs(raw: unknown): NotificationPrefs {
  const parsed = notificationPrefsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { on: [], off: [], sound: true };
}

export function wantsType(prefs: NotificationPrefs, type: NotificationType): boolean {
  if (prefs.off.includes(type)) return false;
  return OPT_IN_TYPES.includes(type) ? prefs.on.includes(type) : true;
}

export const notificationDto = z.object({
  id: z.string(),
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  imageUrl: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type NotificationDto = z.infer<typeof notificationDto>;

export const pushSubscriptionInput = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});
