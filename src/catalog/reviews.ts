import { z } from "zod";
import { prisma } from "../db";
import { conflict, HttpError } from "../lib/errors";
import { readSite } from "../routes/settings";

export const reviewInputSchema = z.object({
  rating: z.number().int().min(1, "Choose a star rating.").max(5),
  title: z.string().trim().max(120, "Keep the title under 120 characters.").optional().default(""),
  body: z.string().trim().min(20, "Tell other shoppers a bit more (at least 20 characters).").max(4000, "Keep your review under 4,000 characters."),
});

export type ReviewEligibility = { canReview: boolean; reason: "ok" | "not_purchased" | "already_reviewed"; verified: boolean };

/** Only shoppers with a delivered order containing the product may review it ("verified buyers"). */
export async function reviewEligibility(userId: string, productId: string): Promise<ReviewEligibility> {
  const [existing, purchase] = await Promise.all([
    prisma.review.findFirst({ where: { userId, productId }, select: { id: true } }),
    prisma.orderItem.findFirst({ where: { productId, order: { userId, status: "DELIVERED" } }, select: { id: true } }),
  ]);
  if (existing) return { canReview: false, reason: "already_reviewed", verified: Boolean(purchase) };
  if (!purchase) return { canReview: false, reason: "not_purchased", verified: false };
  return { canReview: true, reason: "ok", verified: true };
}

/** "Ana Rossi" → "Ana R." (reviews never show full names). */
export function publicName(name: string | null | undefined): string {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!parts.length) return "Verified buyer";
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)![0]!.toUpperCase()}.` : parts[0]!;
}

/** Recomputes a product's rating from approved reviews. */
export async function refreshProductRating(productId: string) {
  const agg = await prisma.review.aggregate({ where: { productId, status: "APPROVED" }, _avg: { rating: true }, _count: true });
  await prisma.product.update({ where: { id: productId }, data: { ratingAvg: agg._avg.rating ?? 0, ratingCount: agg._count } });
}

/** Creates a review; held for moderation when Site Settings require approval. */
export async function createReview(userId: string, productId: string, input: z.infer<typeof reviewInputSchema>) {
  const eligibility = await reviewEligibility(userId, productId);
  if (eligibility.reason === "already_reviewed") throw conflict("You've already reviewed this item.");
  if (!eligibility.canReview) throw new HttpError(403, "not_purchased", "Only shoppers who received this item can review it.");

  const [user, site] = await Promise.all([prisma.user.findUnique({ where: { id: userId }, select: { name: true } }), readSite()]);
  const status = site.features.reviewsRequireApproval ? "PENDING" : "APPROVED";
  const review = await prisma.review.create({
    data: {
      productId,
      userId,
      authorName: publicName(user?.name),
      rating: input.rating,
      title: input.title || null,
      body: input.body,
      status,
      isVerified: eligibility.verified,
    },
    select: { id: true, status: true },
  });
  if (status === "APPROVED") await refreshProductRating(productId);
  return review;
}
