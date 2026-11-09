import sharp from "sharp";
import { z } from "zod";
import { mediaMetaSchema } from "../core";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { isCloudinaryConfigured, uploadBuffer } from "../lib/cloudinary";
import { HttpError, notFound } from "../lib/errors";

/** Admin uploads: raster images only (SVG can carry scripts), up to 8 MB. */
export const ADMIN_UPLOAD = { maxBytes: 8 * 1024 * 1024, types: ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"] } as const;
export const FOLDERS = ["products", "categories", "brands", "banners", "sections", "navigation", "theme", "general"] as const;

export const mediaDto = z.object({
  id: z.string(),
  url: z.string(),
  alt: z.string(),
  isDecorative: z.boolean(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  bytes: z.number().nullable(),
  folder: z.string().nullable(),
  createdAt: z.string(),
});

export const mediaListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  folder: z.enum(FOLDERS).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(12).max(96).default(48),
});

const toDto = (m: { id: string; url: string; alt: string; isDecorative: boolean; width: number | null; height: number | null; bytes: number | null; folder: string | null; createdAt: Date }) => ({
  ...m,
  createdAt: m.createdAt.toISOString(),
});

const select = { id: true, url: true, alt: true, isDecorative: true, width: true, height: true, bytes: true, folder: true, createdAt: true } as const;

export async function listMedia(q: z.infer<typeof mediaListQuery>) {
  const where: Prisma.MediaAssetWhereInput = {
    ...(q.folder ? { folder: q.folder } : {}),
    ...(q.q ? { alt: { contains: q.q, mode: "insensitive" } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.mediaAsset.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select }),
    prisma.mediaAsset.count({ where }),
  ]);
  return { items: rows.map(toDto), total, page: q.page, pageSize: q.pageSize };
}

export async function uploadMedia(input: { buffer: Buffer; mimetype: string; alt: string; isDecorative: boolean; folder: string; uploadedById: string }) {
  if (!isCloudinaryConfigured()) throw new HttpError(503, "uploads_unavailable", "Image uploads need Cloudinary. Add CLOUDINARY_* settings to the backend .env.");
  if (!(ADMIN_UPLOAD.types as readonly string[]).includes(input.mimetype)) throw new HttpError(415, "unsupported_type", "Use a JPG, PNG, WebP, AVIF or GIF image.");
  const meta = mediaMetaSchema.safeParse({ alt: input.alt, isDecorative: input.isDecorative });
  if (!meta.success) throw new HttpError(400, "validation_error", "Check the highlighted fields.", { alt: [meta.error.issues[0]?.message ?? "Add alt text."] });
  // Decoding proves it's really an image (not a renamed file) and gives dimensions.
  const info = await sharp(input.buffer, { failOn: "error", limitInputPixels: 60_000_000 })
    .metadata()
    .catch(() => null);
  if (!info?.width || !info.height) throw new HttpError(400, "unreadable_image", "We couldn't read that image. Try another file.");
  const folder = (FOLDERS as readonly string[]).includes(input.folder) ? input.folder : "general";
  const uploaded = await uploadBuffer(input.buffer, `diau/${folder}`);
  const m = await prisma.mediaAsset.create({
    data: {
      provider: "CLOUDINARY",
      publicId: uploaded.publicId,
      url: uploaded.url,
      width: uploaded.width,
      height: uploaded.height,
      format: uploaded.format,
      bytes: uploaded.bytes,
      alt: meta.data.isDecorative ? "" : meta.data.alt,
      isDecorative: meta.data.isDecorative,
      folder,
      uploadedById: input.uploadedById,
    },
    select,
  });
  return { ...toDto(m), warning: Math.min(info.width, info.height) < 1200 && folder === "products" ? "This image is smaller than 1200×1200, so zoom will look soft." : null };
}

export async function updateMediaMeta(id: string, input: z.infer<typeof mediaMetaSchema>) {
  const exists = await prisma.mediaAsset.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw notFound("Image");
  const m = await prisma.mediaAsset.update({ where: { id }, data: { alt: input.isDecorative ? "" : input.alt, isDecorative: input.isDecorative }, select });
  return toDto(m);
}
