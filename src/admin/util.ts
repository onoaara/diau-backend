import { slugify } from "../core";
import { Prisma } from "../generated/prisma/client";
import { HttpError } from "../lib/errors";

/** A slug not used by any other row: "linen-shirt", "linen-shirt-2", … */
export async function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base) || "item";
  for (let i = 1; i < 500; i++) {
    const candidate = i === 1 ? root : `${root.slice(0, 90)}-${i}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new HttpError(409, "slug_taken", "Couldn't find a free URL slug. Enter one yourself.");
}

/** Prisma unique-constraint errors → a 409 with a field message the admin form can show. */
export function rethrowUnique(err: unknown, fieldByTarget: Record<string, string>): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    const target = JSON.stringify(err.meta ?? {});
    for (const [needle, field] of Object.entries(fieldByTarget)) {
      if (target.includes(needle)) throw new HttpError(409, "already_exists", "That value is already used.", { [field]: ["Already used by another item."] });
    }
    throw new HttpError(409, "already_exists", "One of these values is already used by another item.");
  }
  throw err;
}
