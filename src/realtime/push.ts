import webpush from "web-push";
import { prisma } from "../db";
import { env } from "../env";

/*
 * Web Push (DESIGN.md §5.22): system notifications on phones and computers,
 * even when Diau isn't open. Works in Chrome, Edge, Firefox and Safari on
 * computers and Android, and on iPhone/iPad (iOS 16.4+) once Diau is added to
 * the home screen. The device plays its normal notification sound.
 * Off unless VAPID keys are set (npm run vapid:keys).
 */

export const pushEnabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
if (pushEnabled) webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

export type PushPayload = { title: string; body: string; url: string; tag: string; image?: string | null; type: string };

/** Sends to every device the people turned push on for; forgets devices the push service says are gone. */
export async function sendPush(userIds: string[], payload: PushPayload) {
  if (!pushEnabled || !userIds.length) return;
  const subs = await prisma.pushSubscription.findMany({ where: { userId: { in: userIds } } });
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 24 * 60 * 60, urgency: "normal" });
        await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410: the browser unsubscribed or the app was removed.
        if (status === 404 || status === 410) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      }
    }),
  );
}
