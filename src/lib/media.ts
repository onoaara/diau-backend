import { z } from "zod";

/** Public shape of a media asset sent to the frontend. */
export const mediaDtoSchema = z.object({
  id: z.string(),
  url: z.string(),
  alt: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});
export type MediaDto = z.infer<typeof mediaDtoSchema>;

export const mediaSelect = { id: true, url: true, alt: true, width: true, height: true } as const;

export function toMediaDto(m: MediaDto | null | undefined): MediaDto | null {
  return m ? { id: m.id, url: m.url, alt: m.alt, width: m.width, height: m.height } : null;
}
