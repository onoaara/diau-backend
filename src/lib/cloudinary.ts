import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";

/** Upload limits (DESIGN.md / security: type and size limits on uploads). */
export const UPLOAD_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/svg+xml"] as const,
};

let configured = false;

export function isCloudinaryConfigured(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET,
  );
}

function client() {
  if (!configured) {
    if (!isCloudinaryConfigured()) throw new Error("Cloudinary is not configured (CLOUDINARY_* env vars).");
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
  return cloudinary;
}

export type UploadedImage = {
  publicId: string;
  url: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
};

function toUploaded(r: UploadApiResponse): UploadedImage {
  return { publicId: r.public_id, url: r.secure_url, width: r.width, height: r.height, format: r.format, bytes: r.bytes };
}

/** Uploads from a remote URL (Cloudinary fetches it). Idempotent for a given publicId. */
export async function uploadFromUrl(url: string, publicId: string, folder: string): Promise<UploadedImage> {
  const r = await client().uploader.upload(url, {
    public_id: publicId,
    folder,
    overwrite: false,
    resource_type: "image",
    unique_filename: false,
  });
  return toUploaded(r);
}

/** Uploads a buffer (admin uploads). */
export function uploadBuffer(buffer: Buffer, folder: string): Promise<UploadedImage> {
  return new Promise((resolve, reject) => {
    const stream = client().uploader.upload_stream({ folder, resource_type: "image" }, (err, res) => {
      if (err || !res) reject(err ?? new Error("Upload failed"));
      else resolve(toUploaded(res));
    });
    stream.end(buffer);
  });
}

export async function destroyImage(publicId: string): Promise<void> {
  await client().uploader.destroy(publicId, { resource_type: "image" });
}
