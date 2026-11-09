/**
 * Builds image-search signatures for product main images that don't have one.
 * Safe to re-run; only missing images are processed.
 *   npm run search:index-images              # fill in missing signatures
 *   npm run search:index-images -- --rebuild # recompute all (after changing the algorithm)
 */
import { prisma } from "../src/db";
import { indexProductImages } from "../src/search/image-index";

const started = Date.now();
if (process.argv.includes("--rebuild")) {
  const { count } = await prisma.imageSignature.deleteMany({});
  console.log(`Cleared ${count} existing signatures.`);
}
const result = await indexProductImages({ log: console.log });
console.log(`Indexed ${result.indexed} of ${result.total} images (${result.failed} failed) in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
await prisma.$disconnect();
