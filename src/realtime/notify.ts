import { ADMIN_TYPE_PERMISSION, effectivePermissions, isAdminRole, readPrefs, wantsType, type NotificationDto, type NotificationType } from "../core";
import { prisma } from "../db";
import { sendPush } from "./push";
import { emitToUser } from "./socket";

/*
 * One way to tell people something (DESIGN.md §5.22). For each recipient who
 * wants this type (their settings), it:
 *   1. saves the notification (their bell and notifications page),
 *   2. sends it live to their open tabs, with whether to play the sound,
 *   3. pushes it to their phones and computers (Web Push).
 * Never throws: a notification must not break the order, review or save that
 * caused it.
 */

export type NotificationInput = { type: NotificationType; title: string; body: string; link?: string | null; imageUrl?: string | null };

export async function notifyUsers(userIds: string[], n: NotificationInput) {
  try {
    const unique = [...new Set(userIds)];
    if (!unique.length) return;
    const users = await prisma.user.findMany({ where: { id: { in: unique }, isActive: true }, select: { id: true, notificationPrefs: true } });
    const recipients = users.map((u) => ({ id: u.id, prefs: readPrefs(u.notificationPrefs) })).filter((u) => wantsType(u.prefs, n.type));
    if (!recipients.length) return;

    const createdAt = new Date();
    const rows = await prisma.notification.createManyAndReturn({
      data: recipients.map((r) => ({ userId: r.id, type: n.type, title: n.title, body: n.body, link: n.link ?? null, imageUrl: n.imageUrl ?? null, createdAt })),
      select: { id: true, userId: true },
    });
    for (const row of rows) {
      const dto: NotificationDto = { id: row.id, type: n.type, title: n.title, body: n.body, link: n.link ?? null, imageUrl: n.imageUrl ?? null, readAt: null, createdAt: createdAt.toISOString() };
      const prefs = recipients.find((r) => r.id === row.userId)!.prefs;
      emitToUser(row.userId, "notification", { notification: dto, sound: prefs.sound });
    }
    await sendPush(
      recipients.map((r) => r.id),
      { title: n.title, body: n.body, url: n.link ?? "/", tag: `${n.type}:${n.link ?? n.title}`, image: n.imageUrl ?? null, type: n.type },
    );
  } catch (err) {
    console.error("notify failed", err);
  }
}

/** Every active staff member whose permissions cover this admin type. */
export async function notifyAdmins(n: NotificationInput & { type: keyof typeof ADMIN_TYPE_PERMISSION }) {
  try {
    const staff = await prisma.user.findMany({ where: { isActive: true, role: { in: ["ADMIN", "SUPER_ADMIN", "SELLER"] } }, select: { id: true, role: true, permissions: true } });
    const needed = ADMIN_TYPE_PERMISSION[n.type];
    const ids = staff.filter((u) => (isAdminRole(u.role) || u.role === "SELLER") && (effectivePermissions(u.role, u.permissions) as readonly string[]).includes(needed)).map((u) => u.id);
    await notifyUsers(ids, n);
  } catch (err) {
    console.error("notifyAdmins failed", err);
  }
}
