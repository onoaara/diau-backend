import { env } from "../env";

/**
 * Tells the Next.js frontend to expire cache tags after a backend write.
 * Fire-and-forget: a failed webhook must never fail the admin save, the
 * frontend's own updateTag() call (for admin saves made through it) and
 * cacheLife expiry are the fallbacks.
 */
export function revalidateFrontend(tags: string[]): void {
  if (tags.length === 0) return;
  void fetch(new URL("/api/revalidate", env.FRONTEND_URL), {
    method: "POST",
    headers: { "content-type": "application/json", "x-revalidate-secret": env.REVALIDATE_SECRET },
    body: JSON.stringify({ tags }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {
    // Frontend may be offline in dev; ignore.
  });
}
