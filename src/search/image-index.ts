import { prisma } from "../db";
import { computeSignature, similarity, type ImageSignature } from "./image-signature";

/**
 * Image search provider. The default compares local color/shape signatures in
 * memory, which is fine for a catalog of thousands of products. Larger catalogs
 * should move to an embedding model with a vector index (pgvector), behind this
 * same interface.
 */
export interface ImageSearchProvider {
  /** Stores the query's signature and returns a token for /search?image=<token>. */
  createQuery(image: Buffer): Promise<string>;
  /** Product ids similar to the stored query, best first, limited to `candidates`. Null = unknown/expired token. */
  rank(token: string, candidates: string[]): Promise<string[] | null>;
}

const QUERY_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Matches must score at least MIN_SCORE and RELATIVE × the best match, so a
 * strong match (e.g. the same product photographed) narrows the list while a
 * loose photo still gets a useful set.
 */
const MIN_SCORE = 0.55;
const RELATIVE = 0.7;
const MAX_MATCHES = 48;

/** Signatures of each product's main image (position 0). */
async function productSignatures(productIds: string[]): Promise<Map<string, ImageSignature>> {
  const rows = await prisma.productImage.findMany({
    where: { productId: { in: productIds }, position: 0, media: { imageSignature: { isNot: null } } },
    select: { productId: true, media: { select: { imageSignature: { select: { dhash: true, histogram: true } } } } },
  });
  const map = new Map<string, ImageSignature>();
  for (const r of rows) if (r.media.imageSignature) map.set(r.productId, r.media.imageSignature);
  return map;
}

export const localImageSearch: ImageSearchProvider = {
  async createQuery(image) {
    const sig = await computeSignature(image);
    // Opportunistic cleanup: query signatures only live for a day.
    await prisma.imageQuery.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - QUERY_TTL_MS) } } });
    const q = await prisma.imageQuery.create({ data: { dhash: sig.dhash, histogram: sig.histogram } });
    return q.id;
  },

  async rank(token, candidates) {
    const query = await prisma.imageQuery.findFirst({
      where: { id: token, createdAt: { gte: new Date(Date.now() - QUERY_TTL_MS) } },
      select: { dhash: true, histogram: true },
    });
    if (!query) return null;
    const sigs = await productSignatures(candidates);
    const scored = [...sigs.entries()].map(([id, sig]) => ({ id, score: similarity(query, sig) })).sort((a, b) => b.score - a.score);
    const cutoff = Math.max(MIN_SCORE, (scored[0]?.score ?? 0) * RELATIVE);
    return scored
      .filter((s) => s.score >= cutoff)
      .slice(0, MAX_MATCHES)
      .map((s) => s.id);
  },
};

export const imageSearch: ImageSearchProvider = localImageSearch;

/** Builds signatures for product main images that don't have one yet. */
export async function indexProductImages(opts: { concurrency?: number; log?: (msg: string) => void; db?: typeof prisma } = {}) {
  const log = opts.log ?? (() => {});
  const db = opts.db ?? prisma;
  const media = await db.mediaAsset.findMany({
    where: { imageSignature: null, productImages: { some: { position: 0 } } },
    select: { id: true, url: true },
  });
  let done = 0;
  let failed = 0;
  const queue = [...media];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        // Cloudinary can hand back a small version; other hosts serve the original.
        const url = m.url.replace(/(res\.cloudinary\.com\/[^/]+\/image\/upload\/)/, "$1w_256,c_limit,f_png/");
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const sig = await computeSignature(Buffer.from(await res.arrayBuffer()));
        await db.imageSignature.create({ data: { mediaId: m.id, ...sig } });
        done++;
        if (done % 25 === 0) log(`  …indexed ${done}/${media.length} images`);
      } catch (err) {
        failed++;
        log(`  ! couldn't index ${m.url}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  return { indexed: done, failed, total: media.length };
}
