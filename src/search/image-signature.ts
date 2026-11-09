import sharp from "sharp";

/**
 * Lightweight visual signature for "search by image", computed locally with no
 * paid service:
 * - the uniform background is trimmed (product photos sit on white), then
 * - a 4×4×4 RGB color histogram (64 bins) of the remaining pixels, ignoring
 *   near-white background pixels, and
 * - a 64-bit difference hash (dHash) of the grayscale shape.
 *
 * It finds items of similar color and silhouette, not semantic matches. Swap
 * `imageSearchProvider` for an embedding model (e.g. CLIP) for true visual search.
 */
export type ImageSignature = { dhash: string; histogram: number[] };

const BINS = 4;

export async function computeSignature(input: Buffer): Promise<ImageSignature> {
  const base = sharp(input, { failOn: "error", limitInputPixels: 40_000_000 }).rotate().flatten({ background: "#ffffff" });
  // Trim the plain background; if trimming fails (no uniform border) use the full image.
  const trimmed = await base
    .clone()
    .trim({ threshold: 18 })
    .toBuffer()
    .catch(() => base.clone().toBuffer());

  const [colorRaw, grayRaw] = await Promise.all([
    sharp(trimmed).resize(48, 48, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(trimmed).resize(9, 8, { fit: "fill" }).grayscale().raw().toBuffer(),
  ]);

  return { histogram: histogramOf(colorRaw.data, colorRaw.info.channels), dhash: dhashOf(grayRaw) };
}

/**
 * Soft binning: each channel value is split between its two nearest bin centres,
 * so close colors that straddle a bin edge (e.g. two reds) still overlap.
 */
function softBins(v: number): Array<[number, number]> {
  const pos = (v * BINS) / 256 - 0.5;
  const lo = Math.floor(pos);
  const frac = pos - lo;
  const clamp = (b: number) => Math.min(BINS - 1, Math.max(0, b));
  return [
    [clamp(lo), 1 - frac],
    [clamp(lo + 1), frac],
  ];
}

function histogramOf(pixels: Buffer, channels: number): number[] {
  const hist = new Array<number>(BINS ** 3).fill(0);
  let counted = 0;
  for (let i = 0; i + 2 < pixels.length; i += channels) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    if (r > 235 && g > 235 && b > 235) continue; // leftover white background
    for (const [rb, rw] of softBins(r)) {
      for (const [gb, gw] of softBins(g)) {
        for (const [bb, bw] of softBins(b)) {
          hist[rb * BINS * BINS + gb * BINS + bb]! += rw * gw * bw;
        }
      }
    }
    counted++;
  }
  if (counted === 0) {
    hist[hist.length - 1] = 1; // all white
    return hist;
  }
  return hist.map((v) => Math.round((v / counted) * 10_000) / 10_000);
}

/** 9×8 grayscale → 64 bits: is each pixel brighter than its right neighbour? */
function dhashOf(gray: Buffer): string {
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (gray[y * 9 + x]! > gray[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** 0–1 similarity: color distribution weighs most, silhouette breaks ties. */
export function similarity(a: ImageSignature, b: ImageSignature): number {
  let intersection = 0;
  for (let i = 0; i < a.histogram.length; i++) intersection += Math.min(a.histogram[i] ?? 0, b.histogram[i] ?? 0);
  const shape = 1 - hamming(a.dhash, b.dhash) / 64;
  return 0.65 * intersection + 0.35 * shape;
}
