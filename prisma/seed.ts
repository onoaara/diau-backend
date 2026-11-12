/**
 * Diau demo seed.
 *
 *   npm run db:seed            (from repo root or backend/)
 *
 * WARNING: wipes all application tables first.
 *
 * Images come from free, no-key sources:
 *   - Products: DummyJSON (https://dummyjson.com) product photos
 *   - Banners:  Picsum Photos (https://picsum.photos) seeded photos
 * When CLOUDINARY_* env vars are set, every image is uploaded to Cloudinary and
 * served from there; otherwise the original CDN URLs are stored as REMOTE assets.
 */
import "dotenv/config";
import {
  DEFAULT_THEME,
  siteConfigSchema,
  slugify,
  SECTION_SCHEMAS,
  type SectionType,
} from "../src/core";
import { createPrisma } from "../src/db";
import { hashPassword } from "../src/lib/password";
import { isCloudinaryConfigured, uploadFromUrl } from "../src/lib/cloudinary";
import type { Prisma } from "../src/generated/prisma/client";
import { indexProductImages } from "../src/search/image-index";
import { seedAnalytics } from "./seed-analytics";

const prisma = createPrisma();
const useCloudinary = isCloudinaryConfigured();

// ───────────────────────── deterministic randomness ─────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261107);
const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const chance = (p: number) => rand() < p;
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000);

// ───────────────────────── source data ─────────────────────────

type DummyReview = { rating: number; comment: string; date: string; reviewerName: string };
type DummyProduct = {
  id: number;
  title: string;
  description: string;
  category: string;
  price: number;
  discountPercentage: number;
  rating: number;
  stock: number;
  tags: string[];
  brand?: string;
  sku: string;
  weight: number;
  dimensions: { width: number; height: number; depth: number };
  warrantyInformation: string;
  shippingInformation: string;
  returnPolicy: string;
  reviews: DummyReview[];
  images: string[];
  thumbnail: string;
};

async function fetchProducts(): Promise<DummyProduct[]> {
  const res = await fetch("https://dummyjson.com/products?limit=0", { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`DummyJSON responded ${res.status}`);
  const json = (await res.json()) as { products: DummyProduct[] };
  return json.products;
}

/**
 * Category tree. Leaf `sources` are DummyJSON category slugs.
 * Three levels where it helps (Fashion → Men → Shirts) to exercise nesting.
 */
type CatDef = { name: string; icon?: string; sources?: string[]; children?: CatDef[]; featured?: boolean };
const CATEGORY_TREE: CatDef[] = [
  {
    name: "Electronics",
    icon: "smartphone",
    featured: true,
    children: [
      { name: "Cell phones & smartphones", sources: ["smartphones"] },
      { name: "Laptops & netbooks", sources: ["laptops"] },
      { name: "Tablets & e-readers", sources: ["tablets"] },
      { name: "Phone accessories", sources: ["mobile-accessories"] },
    ],
  },
  {
    name: "Fashion",
    icon: "shirt",
    featured: true,
    children: [
      {
        name: "Men",
        children: [
          { name: "Men's shirts", sources: ["mens-shirts"] },
          { name: "Men's shoes", sources: ["mens-shoes"] },
        ],
      },
      {
        name: "Women",
        children: [
          { name: "Women's tops", sources: ["tops"] },
          { name: "Dresses", sources: ["womens-dresses"] },
          { name: "Women's shoes", sources: ["womens-shoes"] },
        ],
      },
    ],
  },
  {
    name: "Bags & accessories",
    icon: "shopping-bag",
    featured: true,
    children: [
      { name: "Handbags", sources: ["womens-bags"] },
      { name: "Sunglasses", sources: ["sunglasses"] },
    ],
  },
  {
    name: "Watches & jewelry",
    icon: "watch",
    featured: true,
    children: [
      { name: "Men's watches", sources: ["mens-watches"] },
      { name: "Women's watches", sources: ["womens-watches"] },
      { name: "Fine jewelry", sources: ["womens-jewellery"] },
    ],
  },
  {
    name: "Health & beauty",
    icon: "sparkles",
    featured: true,
    children: [
      { name: "Makeup", sources: ["beauty"] },
      { name: "Skin care", sources: ["skin-care"] },
      { name: "Fragrances", sources: ["fragrances"] },
    ],
  },
  {
    name: "Home & garden",
    icon: "sofa",
    featured: true,
    children: [
      { name: "Furniture", sources: ["furniture"] },
      { name: "Home decor", sources: ["home-decoration"] },
    ],
  },
  {
    name: "Kitchen & dining",
    icon: "utensils",
    featured: true,
    children: [{ name: "Kitchen tools & gadgets", sources: ["kitchen-accessories"] }],
  },
  {
    name: "Groceries",
    icon: "apple",
    featured: true,
    children: [{ name: "Food & drink", sources: ["groceries"] }],
  },
  {
    name: "Sporting goods",
    icon: "dumbbell",
    featured: true,
    children: [{ name: "Sports equipment", sources: ["sports-accessories"] }],
  },
  {
    name: "Motors",
    icon: "car",
    featured: true,
    children: [
      { name: "Cars & trucks", sources: ["vehicle"] },
      { name: "Motorcycles", sources: ["motorcycle"] },
    ],
  },
];

const LOCATIONS = [
  "Austin, TX", "Brooklyn, NY", "Seattle, WA", "Denver, CO", "Chicago, IL", "Atlanta, GA",
  "Portland, OR", "Miami, FL", "Phoenix, AZ", "Columbus, OH", "San Diego, CA", "Nashville, TN",
];

const REVIEW_SNIPPETS: Record<number, string[]> = {
  5: ["Exactly as described and arrived early.", "Great quality for the price.", "Would buy again without hesitation.", "Exceeded my expectations.", "Packaged well, works perfectly."],
  4: ["Very good overall, minor quibbles.", "Solid purchase, shipping took a bit.", "Good value. Does the job well.", "Nice, though the color is slightly different."],
  3: ["It's okay. Does what it says.", "Average quality, fair price.", "Fine for occasional use."],
  2: ["Not quite what I expected.", "Quality could be better."],
  1: ["Disappointed, returning it."],
};
const REVIEWER_NAMES = ["Ana P.", "Marcus L.", "Priya S.", "Tom W.", "Jade K.", "Luis R.", "Hannah B.", "Omar D.", "Chen Y.", "Sofia M.", "Ben A.", "Grace O."];

// ───────────────────────── media ─────────────────────────

type MediaInput = { url: string; alt: string; folder: string; key: string; decorative?: boolean; width?: number; height?: number };

async function runPool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

let uploaded = 0;
async function createMedia(input: MediaInput): Promise<string> {
  const base = {
    alt: input.decorative ? "" : input.alt,
    isDecorative: Boolean(input.decorative),
    folder: input.folder,
    tags: ["seed"],
  };
  if (useCloudinary) {
    try {
      const img = await uploadFromUrl(input.url, input.key, `diau/${input.folder}`);
      uploaded++;
      if (uploaded % 50 === 0) console.log(`  …uploaded ${uploaded} images to Cloudinary`);
      const m = await prisma.mediaAsset.create({
        data: { ...base, provider: "CLOUDINARY", publicId: img.publicId, url: img.url, width: img.width, height: img.height, format: img.format, bytes: img.bytes },
      });
      return m.id;
    } catch (err) {
      console.warn(`  ! Cloudinary upload failed for ${input.url}, storing remote URL instead:`, (err as Error).message);
    }
  }
  const m = await prisma.mediaAsset.create({
    data: { ...base, provider: "REMOTE", url: input.url, width: input.width ?? null, height: input.height ?? null },
  });
  return m.id;
}

// ───────────────────────── helpers ─────────────────────────

function tiptapDoc(paragraphs: string[], bullets: string[] = []): Prisma.InputJsonValue {
  const content: Prisma.InputJsonValue[] = paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] }));
  if (bullets.length) {
    content.push({
      type: "bulletList",
      content: bullets.map((text) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] })),
    });
  }
  return { type: "doc", content };
}

function sectionConfig<T extends SectionType>(type: T, config: unknown): Prisma.InputJsonValue {
  // Validate seed data against the same schemas the admin uses.
  return SECTION_SCHEMAS[type].parse(config) as Prisma.InputJsonValue;
}

async function wipe() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const started = Date.now();
  console.log(`Seeding Diau (images: ${useCloudinary ? "Cloudinary upload" : "remote URLs"})`);

  console.log("• Fetching products from DummyJSON");
  const source = await fetchProducts();
  console.log(`  ${source.length} products`);

  console.log("• Clearing tables");
  await wipe();

  // ── Users
  console.log("• Users");
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@diau.test").toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "Diau-admin-2026!";
  const superAdmin = await prisma.user.create({
    data: { email: adminEmail, name: "Diau Admin", role: "SUPER_ADMIN", passwordHash: await hashPassword(adminPassword), emailVerified: new Date() },
  });
  const customerHash = await hashPassword("Diau-shopper-2026!");
  await prisma.user.create({
    data: { email: "editor@diau.test", name: "Store Editor", role: "ADMIN", passwordHash: customerHash, permissions: ["dashboard:read", "products:read", "products:write", "categories:write", "storefront:write", "media:write", "reviews:write"] },
  });
  const customers = await Promise.all(
    ["Ana Pereira", "Marcus Lee", "Priya Shah", "Tom Walsh", "Jade Kim"].map((name, i) =>
      prisma.user.create({
        data: {
          name,
          email: i === 0 ? "shopper@diau.test" : `${slugify(name)}@example.test`,
          passwordHash: customerHash,
          createdAt: daysAgo(int(10, 200)),
          addresses: {
            create: { fullName: name, line1: `${int(10, 999)} Market St`, city: pick(["Austin", "Denver", "Seattle"]), region: pick(["TX", "CO", "WA"]), postalCode: String(int(10000, 99999)), country: "US", isDefault: true },
          },
        },
      }),
    ),
  );

  // ── Categories
  console.log("• Categories");
  const sourceToCategory = new Map<string, string>(); // dummy category slug → leaf category id
  const categoryById = new Map<string, { id: string; name: string; parentId: string | null; topId: string }>();
  const topLevelIds: string[] = [];
  const firstImageBySource = new Map<string, string>();
  for (const p of source) if (!firstImageBySource.has(p.category)) firstImageBySource.set(p.category, p.thumbnail);

  async function createCategory(def: CatDef, parentId: string | null, position: number, topId: string | null, parentSlug = ""): Promise<string> {
    const slug = slugify(parentSlug && !def.sources ? `${parentSlug}-${def.name}` : def.name);
    const leafSources = collectSources(def);
    const img = firstImageBySource.get(leafSources[0] ?? "");
    const imageId = img
      ? await createMedia({ url: img, alt: def.name, folder: "categories", key: `cat-${slug}` })
      : null;
    const cat = await prisma.category.create({
      data: {
        name: def.name,
        slug,
        parentId,
        position,
        icon: def.icon ?? null,
        imageId,
        description: `Shop ${def.name.toLowerCase()} on Diau: new, used and refurbished, with fast shipping and easy returns.`,
        featuredOnHome: Boolean(def.featured),
        seoTitle: `${def.name} for sale`,
        seoDescription: `Discover great deals on ${def.name.toLowerCase()}. Free shipping on many items.`,
      },
    });
    const root = topId ?? cat.id;
    if (!parentId) topLevelIds.push(cat.id);
    categoryById.set(cat.id, { id: cat.id, name: cat.name, parentId, topId: root });
    for (const s of def.sources ?? []) sourceToCategory.set(s, cat.id);
    for (const [i, child] of (def.children ?? []).entries()) await createCategory(child, cat.id, i, root, slug);
    return cat.id;
  }
  function collectSources(def: CatDef): string[] {
    return [...(def.sources ?? []), ...(def.children ?? []).flatMap(collectSources)];
  }
  for (const [i, def] of CATEGORY_TREE.entries()) await createCategory(def, null, i, null);
  const topBySlug = new Map((await prisma.category.findMany({ where: { parentId: null } })).map((c) => [c.slug, c]));

  // ── Attributes & filters
  console.log("• Attributes & filters");
  async function attribute(name: string, type: Prisma.AttributeCreateInput["type"], values: Array<string | { value: string; hex: string }> = [], opts: Partial<Prisma.AttributeCreateInput> = {}) {
    return prisma.attribute.create({
      data: {
        name,
        slug: slugify(name),
        type,
        ...opts,
        values: {
          create: values.map((v, i) =>
            typeof v === "string" ? { value: v, slug: slugify(v), position: i } : { value: v.value, slug: slugify(v.value), swatchHex: v.hex, position: i },
          ),
        },
      },
      include: { values: true },
    });
  }
  const color = await attribute("Color", "COLOR", [
    { value: "Black", hex: "#111111" }, { value: "White", hex: "#F5F5F5" }, { value: "Gray", hex: "#8A8F98" },
    { value: "Blue", hex: "#2F5BD3" }, { value: "Red", hex: "#C62828" }, { value: "Green", hex: "#2E7D4F" },
    { value: "Beige", hex: "#D8C3A5" }, { value: "Pink", hex: "#E991B5" }, { value: "Brown", hex: "#6D4C3D" }, { value: "Gold", hex: "#C9A13B" },
  ]);
  const size = await attribute("Size", "SELECT", ["XS", "S", "M", "L", "XL", "XXL"]);
  const shoeSize = await attribute("Shoe size", "SELECT", ["6", "7", "8", "9", "10", "11", "12"]);
  const storage = await attribute("Storage capacity", "SELECT", ["64 GB", "128 GB", "256 GB", "512 GB", "1 TB"]);
  const material = await attribute("Material", "MULTI_SELECT", ["Wood", "Metal", "Glass", "Fabric", "Leather", "Plastic", "Ceramic"]);
  const screen = await attribute("Screen size", "RANGE", [], { unit: "in" });
  const waterproof = await attribute("Water resistant", "BOOLEAN");
  const warranty = await attribute("Warranty", "TEXT", [], { isFilterable: false });
  const dimensions = await attribute("Dimensions", "TEXT", [], { isFilterable: false });
  const weight = await attribute("Item weight", "NUMBER", [], { unit: "g", isFilterable: false });

  const BUILT_INS = ["PRICE", "BRAND", "CONDITION", "RATING", "SHIPPING", "LOCATION"] as const;
  const BUILT_IN_DISPLAY = { PRICE: "SLIDER", BRAND: "CHECKBOX", CONDITION: "CHECKBOX", RATING: "CHECKBOX", SHIPPING: "TOGGLE", LOCATION: "DROPDOWN" } as const;
  for (const topId of topLevelIds) {
    await prisma.categoryAttribute.createMany({
      data: BUILT_INS.map((b, i) => ({ categoryId: topId, builtIn: b, displayType: BUILT_IN_DISPLAY[b], position: i * 10, isCollapsed: i > 3 })),
    });
  }
  const customFilters: Array<[string, { id: string }, Prisma.CategoryAttributeCreateManyInput["displayType"]]> = [
    ["electronics", storage, "CHECKBOX"], ["electronics", color, "SWATCH"], ["electronics", screen, "SLIDER"],
    ["fashion", size, "CHECKBOX"], ["fashion", shoeSize, "CHECKBOX"], ["fashion", color, "SWATCH"],
    ["bags-and-accessories", color, "SWATCH"], ["bags-and-accessories", material, "CHECKBOX"],
    ["watches-and-jewelry", color, "SWATCH"], ["watches-and-jewelry", waterproof, "TOGGLE"], ["watches-and-jewelry", material, "CHECKBOX"],
    ["home-and-garden", material, "CHECKBOX"], ["home-and-garden", color, "SWATCH"],
    ["kitchen-and-dining", material, "CHECKBOX"], ["motors", color, "SWATCH"],
  ];
  for (const [i, [slug, attr, display]] of customFilters.entries()) {
    const cat = topBySlug.get(slug);
    if (cat) await prisma.categoryAttribute.create({ data: { categoryId: cat.id, attributeId: attr.id, displayType: display, position: 5 + i } });
  }
  const val = (a: { values: { id: string; value: string }[] }, v: string) => a.values.find((x) => x.value === v)!.id;

  // ── Brands & tags
  console.log("• Brands & tags");
  const brandIds = new Map<string, string>();
  for (const name of [...new Set(source.map((p) => p.brand).filter((b): b is string => Boolean(b)))]) {
    const b = await prisma.brand.create({ data: { name, slug: slugify(name), isFeatured: false } });
    brandIds.set(name, b.id);
  }
  const brandCounts = new Map<string, number>();
  for (const p of source) if (p.brand) brandCounts.set(p.brand, (brandCounts.get(p.brand) ?? 0) + 1);
  const featuredBrands = [...brandCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => n);
  await prisma.brand.updateMany({ where: { name: { in: featuredBrands } }, data: { isFeatured: true } });

  const tagIds = new Map<string, string>();
  for (const t of [...new Set(source.flatMap((p) => p.tags))]) {
    const tag = await prisma.tag.create({ data: { name: t, slug: slugify(t) } });
    tagIds.set(t, tag.id);
  }
  const trendingTag = await prisma.tag.upsert({ where: { slug: "trending" }, create: { name: "Trending", slug: "trending" }, update: {} });

  // ── Products
  console.log("• Products, images, variants, reviews");
  const productRows: Array<{ id: string; slug: string; title: string; priceCents: number; categoryId: string; topSlug: string; image: string }> = [];
  const usedSlugs = new Set<string>();

  await runPool(source, useCloudinary ? 4 : 8, async (p) => {
    const categoryId = sourceToCategory.get(p.category);
    if (!categoryId) return;
    const cat = categoryById.get(categoryId)!;
    const top = categoryById.get(cat.topId)!;
    const topSlug = [...topBySlug.values()].find((c) => c.id === top.id)!.slug;

    let slug = slugify(p.title);
    while (usedSlugs.has(slug)) slug = `${slug}-${p.id}`;
    usedSlugs.add(slug);

    const priceCents = Math.round(p.price * 100);
    const onSale = p.discountPercentage >= 8;
    const rawCompareAt = onSale ? Math.round(priceCents / (1 - p.discountPercentage / 100) / 100) * 100 - 1 : null;
    // Never store a "compare-at" price that isn't actually higher (no fake discounts).
    const compareAtPriceCents = rawCompareAt && rawCompareAt > priceCents ? rawCompareAt : null;
    const isUsedable = ["smartphones", "laptops", "tablets", "vehicle", "motorcycle", "mens-watches", "womens-watches", "furniture"].includes(p.category);
    const condition = isUsedable && chance(0.3) ? (chance(0.5) ? "USED" : "REFURBISHED") : "NEW";

    // Images
    const imageUrls = [...new Set(p.images)].slice(0, 6);
    const mediaIds = await Promise.all(
      imageUrls.map((url, i) =>
        createMedia({ url, alt: i === 0 ? p.title : `${p.title}, view ${i + 1}`, folder: "products", key: `${slug}-${i + 1}`, width: 600, height: 600 }),
      ),
    );

    // Reviews (DummyJSON reviews + generated ones, all approved)
    const extra = int(2, 30);
    const reviews = [
      ...p.reviews.map((r) => ({ rating: r.rating, body: r.comment, authorName: r.reviewerName, createdAt: new Date(r.date) })),
      ...Array.from({ length: extra }, () => {
        const rating = Math.max(1, Math.min(5, Math.round(p.rating + (rand() - 0.4) * 2)));
        return { rating, body: pick(REVIEW_SNIPPETS[rating]!), authorName: pick(REVIEWER_NAMES), createdAt: daysAgo(int(1, 300)) };
      }),
    ];
    const ratingAvg = Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10;

    const tags = [...p.tags.map((t) => ({ id: tagIds.get(t)! })), ...(chance(0.18) ? [{ id: trendingTag.id }] : [])];
    const brandName = p.brand ?? null;

    // Attributes
    const attrs: Prisma.ProductAttributeCreateWithoutProductInput[] = [
      { attribute: { connect: { id: warranty.id } }, textValue: p.warrantyInformation },
      { attribute: { connect: { id: dimensions.id } }, textValue: `${p.dimensions.width} × ${p.dimensions.height} × ${p.dimensions.depth} cm` },
      { attribute: { connect: { id: weight.id } }, numberValue: p.weight * 100 },
    ];
    const colorName = pick(color.values).value;
    if (["electronics", "fashion", "bags-and-accessories", "watches-and-jewelry", "home-and-garden", "motors"].includes(topSlug)) {
      attrs.push({ attribute: { connect: { id: color.id } }, value: { connect: { id: val(color, colorName) } } });
    }
    if (["bags-and-accessories", "watches-and-jewelry", "home-and-garden", "kitchen-and-dining"].includes(topSlug)) {
      for (const m of [pick(material.values), pick(material.values)]) attrs.push({ attribute: { connect: { id: material.id } }, value: { connect: { id: m.id } } });
    }
    if (["smartphones", "tablets", "laptops"].includes(p.category)) {
      const inches = p.category === "smartphones" ? int(58, 69) / 10 : p.category === "tablets" ? int(80, 129) / 10 : int(130, 170) / 10;
      attrs.push({ attribute: { connect: { id: screen.id } }, numberValue: inches });
    }
    if (p.category.endsWith("watches")) attrs.push({ attribute: { connect: { id: waterproof.id } }, booleanValue: chance(0.6) });

    // Variants
    let options: Prisma.ProductOptionCreateWithoutProductInput[] = [];
    let variants: Prisma.ProductVariantCreateWithoutProductInput[] = [];
    const stockFor = () => (chance(0.08) ? 0 : int(1, 40));
    if (["mens-shirts", "tops", "womens-dresses"].includes(p.category)) {
      const sizes = ["S", "M", "L", "XL"];
      options = [{ name: "Size", position: 0, values: sizes.map((value) => ({ value })) }];
      variants = sizes.map((s, i) => ({ title: s, options: { Size: s }, stock: stockFor(), position: i, sku: `${p.sku}-${s}` }));
      for (const s of sizes) attrs.push({ attribute: { connect: { id: size.id } }, value: { connect: { id: val(size, s) } } });
    } else if (["mens-shoes", "womens-shoes"].includes(p.category)) {
      const sizes = ["7", "8", "9", "10", "11"];
      options = [{ name: "Size", position: 0, values: sizes.map((value) => ({ value })) }];
      variants = sizes.map((s, i) => ({ title: `US ${s}`, options: { Size: s }, stock: stockFor(), position: i, sku: `${p.sku}-${s}` }));
      for (const s of sizes) attrs.push({ attribute: { connect: { id: shoeSize.id } }, value: { connect: { id: val(shoeSize, s) } } });
    } else if (["smartphones", "tablets"].includes(p.category)) {
      const caps = ["128 GB", "256 GB", "512 GB"];
      const colors = [colorName, pick(color.values.filter((c) => c.value !== colorName)).value];
      options = [
        { name: "Storage", position: 0, values: caps.map((value) => ({ value })) },
        { name: "Color", position: 1, values: colors.map((value) => ({ value, swatchHex: color.values.find((c) => c.value === value)!.swatchHex })) },
      ];
      let pos = 0;
      for (const [ci, c] of caps.entries()) {
        for (const col of colors) {
          variants.push({
            title: `${c} / ${col}`,
            options: { Storage: c, Color: col },
            priceCents: priceCents + ci * 10_000,
            compareAtPriceCents: compareAtPriceCents ? compareAtPriceCents + ci * 10_000 : null,
            stock: stockFor(),
            position: pos++,
            sku: `${p.sku}-${c.replace(" ", "")}-${col.toUpperCase()}`,
          });
        }
        attrs.push({ attribute: { connect: { id: storage.id } }, value: { connect: { id: val(storage, c) } } });
      }
    }

    const descriptionText = p.description;
    const created = await prisma.product.create({
      data: {
        title: p.title,
        slug,
        description: tiptapDoc([p.description], [p.warrantyInformation, p.shippingInformation, p.returnPolicy].filter((s) => s && s !== "No return policy")),
        descriptionText,
        status: "ACTIVE",
        condition,
        brand: brandName ? { connect: { id: brandIds.get(brandName)! } } : undefined,
        category: { connect: { id: categoryId } },
        sku: p.sku,
        priceCents,
        compareAtPriceCents,
        stock: variants.length ? 0 : p.stock,
        freeShipping: priceCents >= 3500 || chance(0.3),
        location: pick(LOCATIONS),
        weightGrams: Math.round(p.weight * 100),
        ratingAvg,
        ratingCount: reviews.length,
        soldCount: int(0, 2500),
        createdAt: daysAgo(int(0, 120)),
        searchText: [brandName, cat.name, top.name, ...p.tags].filter(Boolean).join(" "),
        seoDescription: descriptionText.slice(0, 155),
        tags: { connect: tags },
        images: { create: mediaIds.map((mediaId, i) => ({ mediaId, position: i })) },
        attributes: { create: attrs },
        options: { create: options },
        variants: { create: variants },
        reviews: {
          create: reviews.map((r) => ({ ...r, status: "APPROVED" as const, isVerified: chance(0.7) })),
        },
      },
    });
    productRows.push({ id: created.id, slug, title: p.title, priceCents, categoryId, topSlug, image: imageUrls[0] ?? p.thumbnail });
  });
  productRows.sort((a, b) => a.slug.localeCompare(b.slug));
  console.log(`  ${productRows.length} products`);

  // A few unapproved reviews for the moderation queue
  for (const p of productRows.slice(0, 6)) {
    await prisma.review.create({
      data: { productId: p.id, authorName: pick(REVIEWER_NAMES), rating: int(1, 5), title: "Pending review", body: "Arrived quickly. Will update after a week of use.", status: "PENDING", userId: customers[0]!.id },
    });
  }

  // ── Promotions & coupons
  console.log("• Promotions & coupons");
  const onSale = await prisma.product.findMany({ where: { compareAtPriceCents: { not: null } }, orderBy: { soldCount: "desc" }, take: 16, select: { id: true } });
  const dailyDeals = await prisma.promotion.create({
    data: {
      name: "Daily deals",
      type: "DEAL_OF_THE_DAY",
      discountType: "PERCENT",
      value: 1500,
      startsAt: daysAgo(1),
      endsAt: daysFromNow(30),
      products: { create: onSale.slice(0, 12).map((p) => ({ productId: p.id })) },
    },
  });
  const flash = await prisma.promotion.create({
    data: {
      name: "Weekend flash sale",
      type: "FLASH_SALE",
      discountType: "PERCENT",
      value: 2500,
      startsAt: daysAgo(0),
      endsAt: daysFromNow(3),
      products: { create: onSale.slice(12, 16).map((p) => ({ productId: p.id })) },
    },
  });
  await prisma.coupon.createMany({
    data: [
      { code: "WELCOME10", description: "10% off your first order", type: "PERCENT", value: 1000, perCustomerLimit: 1 },
      { code: "FREESHIP", description: "Free standard shipping", type: "FREE_SHIPPING", value: 0, minSubtotalCents: 2500 },
      { code: "SAVE20", description: "$20 off orders over $150", type: "FIXED", value: 2000, minSubtotalCents: 15_000, endsAt: daysFromNow(60) },
    ],
  });

  // ── Banners (Picsum photos — decorative backgrounds; headline text carries meaning)
  console.log("• Banners");
  const picsum = (seed: string, w: number, h: number) => `https://picsum.photos/seed/${seed}/${w}/${h}`;
  async function banner(seed: string, data: Omit<Prisma.BannerUncheckedCreateInput, "desktopImageId" | "mobileImageId">) {
    const desktopImageId = await createMedia({ url: picsum(seed, 2400, 800), alt: "", decorative: true, folder: "banners", key: `banner-${seed}-desktop`, width: 2400, height: 800 });
    const mobileImageId = await createMedia({ url: picsum(seed, 1080, 1080), alt: "", decorative: true, folder: "banners", key: `banner-${seed}-mobile`, width: 1080, height: 1080 });
    return prisma.banner.create({ data: { ...data, desktopImageId, mobileImageId } });
  }
  const hero1 = await banner("diau-hero-tech", { name: "Hero: Tech refresh", headline: "Upgrade your tech for less", subtext: "New and certified refurbished phones, laptops and tablets.", ctaLabel: "Shop electronics", linkUrl: "/c/electronics", ctaStyle: "accent", layout: "text-left", backgroundColor: "#E3F4EF", textTone: "dark" });
  const hero2 = await banner("diau-hero-home", { name: "Hero: Home refresh", headline: "Make home feel new", subtext: "Furniture, decor and kitchen finds from sellers you can trust.", ctaLabel: "Shop home & garden", linkUrl: "/c/home-and-garden", ctaStyle: "brand", layout: "text-right", backgroundColor: "#FEF0C7", textTone: "dark" });
  const hero3 = await banner("diau-hero-style", { name: "Hero: Style", headline: "Fresh fits, fair prices", subtext: "Shirts, dresses, shoes and bags for every day.", ctaLabel: "Shop fashion", linkUrl: "/c/fashion", ctaStyle: "brand", layout: "text-left", backgroundColor: "#14213D", textTone: "light" });
  const promoA = await banner("diau-promo-watches", { name: "Promo: Watches", headline: "Watches from $49", ctaLabel: "Shop watches", linkUrl: "/c/watches-and-jewelry", ctaStyle: "brand", layout: "text-left", backgroundColor: "#F1F3F6", textTone: "dark" });
  const promoB = await banner("diau-promo-beauty", { name: "Promo: Beauty", headline: "Beauty bestsellers", ctaLabel: "Shop beauty", linkUrl: "/c/health-and-beauty", ctaStyle: "brand", layout: "text-left", backgroundColor: "#FCE4EE", textTone: "dark" });

  // ── Homepage
  console.log("• Homepage & pages");
  const electronics = topBySlug.get("electronics")!;
  const homeSections: Array<{ type: SectionType; title?: string; subtitle?: string; seeAllUrl?: string; config: unknown; background?: Prisma.InputJsonValue; device?: "ALL" | "DESKTOP" | "MOBILE" }> = [
    { type: "hero", config: { bannerIds: [hero1.id, hero2.id, hero3.id], autoplay: true, intervalMs: 6000 } },
    { type: "category-tiles", title: "Shop by category", config: { style: "circles", max: 10 } },
    { type: "product-carousel", title: "Daily deals", subtitle: "New deals every day. Prices as marked.", seeAllUrl: "/deals", config: { source: { kind: "promotion", promotionId: dailyDeals.id }, limit: 12 } },
    { type: "promo-banner", config: { layout: "split", bannerIds: [promoA.id, promoB.id] } },
    { type: "product-carousel", title: "Trending now", seeAllUrl: "/search?tag=trending", config: { source: { kind: "tag", tagSlug: "trending" }, limit: 12 } },
    { type: "deal-countdown", title: "Weekend flash sale", config: { endsAt: flash.endsAt.toISOString(), headline: "Weekend flash sale", body: "Up to 25% off selected items while the timer runs.", source: { kind: "promotion", promotionId: flash.id }, limit: 4, ctaLabel: "Shop the sale", ctaUrl: "/deals" }, background: { style: "subtle" } },
    { type: "product-carousel", title: "Top rated in electronics", seeAllUrl: "/c/electronics?sort=rating", config: { source: { kind: "top-rated", categoryId: electronics.id }, limit: 12 } },
    { type: "brand-strip", title: "Popular brands", config: { grayscale: true } },
    { type: "product-carousel", title: "Recently viewed", config: { source: { kind: "recently-viewed" }, limit: 12 } },
    { type: "product-grid", title: "More to explore", config: { source: { kind: "newest" }, pageSize: 24, pagination: "infinite", maxItems: 120 } },
    {
      type: "rich-text",
      title: "Shop with confidence",
      config: {
        html: "<p><strong>Every order is covered.</strong> If an item doesn't arrive or isn't as described, we'll make it right. Most items can be returned within 30 days.</p><p>Questions before you buy? Read the <a href=\"/faq\">FAQ</a> or <a href=\"/help\">contact us</a>.</p>",
        width: "content",
        align: "center",
      },
    },
    { type: "newsletter", config: {}, background: { style: "brand" } },
  ];
  await prisma.page.create({
    data: {
      slug: "home",
      title: "Home",
      kind: "HOME",
      status: "PUBLISHED",
      publishedAt: new Date(),
      sections: {
        create: homeSections.map((s, i) => ({
          type: s.type,
          title: s.title ?? null,
          subtitle: s.subtitle ?? null,
          seeAllUrl: s.seeAllUrl ?? null,
          config: sectionConfig(s.type, s.config),
          background: s.background,
          device: s.device ?? "ALL",
          position: i,
        })),
      },
    },
  });
  await prisma.page.create({
    data: {
      slug: "deals-week",
      title: "Deals week",
      kind: "LANDING",
      status: "PUBLISHED",
      publishedAt: new Date(),
      seoDescription: "A week of hand-picked deals across every category.",
      sections: {
        create: [
          { type: "hero", position: 0, config: sectionConfig("hero", { bannerIds: [hero1.id] }) },
          { type: "product-grid", position: 1, title: "All deals", config: sectionConfig("product-grid", { source: { kind: "on-sale" }, pagination: "paged" }) },
        ],
      },
    },
  });

  const contentPages: Array<[string, string, string[]]> = [
    ["about", "About Diau", ["Diau is a marketplace for buying and selling almost anything, from everyday essentials to hard-to-find pieces.", "We focus on clear listings, honest prices and fast, reliable delivery."]],
    ["help", "Help & contact", ["Most questions are answered in our FAQ. For anything else, email support@diau.test and we'll reply within one business day."]],
    ["faq", "Frequently asked questions", ["How long does shipping take? Most orders arrive in 3–7 business days. You'll see the estimate before you pay.", "Can I return an item? Yes. Most items can be returned within 30 days of delivery.", "Do I need an account to buy? No. You can check out as a guest and create an account afterwards."]],
    ["terms", "Terms of use", ["These demo terms describe how Diau may be used. Replace this text with your own terms before launch."]],
    ["privacy", "Privacy policy", ["This demo policy describes how Diau handles personal data. Replace this text with your own policy before launch."]],
    ["accessibility", "Accessibility", ["Diau aims to meet WCAG 2.2 AA. Every page works with a keyboard and a screen reader.", "If something gets in your way, email support@diau.test and tell us what happened."]],
  ];
  for (const [slug, title, paragraphs] of contentPages) {
    await prisma.page.create({ data: { slug, title, kind: "CONTENT", status: "PUBLISHED", publishedAt: new Date(), content: tiptapDoc(paragraphs) } });
  }

  // ── Navigation
  console.log("• Navigation");
  const utility = await prisma.navigationMenu.create({ data: { key: "utility", name: "Header utility links" } });
  await prisma.menuItem.createMany({
    data: [
      { menuId: utility.id, label: "Daily deals", url: "/deals", position: 0 },
      { menuId: utility.id, label: "Help & contact", url: "/help", position: 1 },
    ],
  });

  const strip = await prisma.navigationMenu.create({ data: { key: "category-strip", name: "Category tab strip & mega-menu" } });
  const tree = await prisma.category.findMany({ orderBy: { position: "asc" }, select: { id: true, name: true, slug: true, parentId: true } });
  const childrenOf = (id: string) => tree.filter((c) => c.parentId === id);
  for (const [i, top] of tree.filter((c) => !c.parentId).entries()) {
    const topItem = await prisma.menuItem.create({ data: { menuId: strip.id, kind: "CATEGORY", label: top.name, categoryId: top.id, url: `/c/${top.slug}`, position: i } });
    for (const [j, child] of childrenOf(top.id).entries()) {
      const column = await prisma.menuItem.create({ data: { menuId: strip.id, parentId: topItem.id, kind: "COLUMN", label: child.name, categoryId: child.id, url: `/c/${child.slug}`, position: j } });
      for (const [k, leaf] of childrenOf(child.id).entries()) {
        await prisma.menuItem.create({ data: { menuId: strip.id, parentId: column.id, kind: "CATEGORY", label: leaf.name, categoryId: leaf.id, url: `/c/${leaf.slug}`, position: k } });
      }
    }
    const featuredProduct = productRows.find((p) => p.topSlug === top.slug);
    if (featuredProduct) {
      const imageId = (await prisma.productImage.findFirst({ where: { productId: featuredProduct.id }, orderBy: { position: "asc" } }))?.mediaId ?? null;
      await prisma.menuItem.create({
        data: { menuId: strip.id, parentId: topItem.id, kind: "FEATURED", label: `Top pick in ${top.name.toLowerCase()}`, description: featuredProduct.title, url: `/p/${featuredProduct.slug}`, imageId, position: 99 },
      });
    }
  }

  const footer = await prisma.navigationMenu.create({ data: { key: "footer", name: "Footer columns" } });
  const footerCols: Array<[string, Array<[string, string]>]> = [
    ["Buy", [["Registration", "/register"], ["Daily deals", "/deals"], ["Shop by category", "/categories"], ["Brands", "/brands"]]],
    ["Sell", [["Start selling", "/sell"], ["How selling works", "/help"], ["Seller fees", "/help"]]],
    ["About Diau", [["Company info", "/about"], ["Policies", "/terms"], ["Privacy", "/privacy"]]],
    ["Help & contact", [["Help center", "/help"], ["FAQ", "/faq"], ["Returns", "/faq"], ["Contact us", "/help"]]],
  ];
  for (const [i, [label, links]] of footerCols.entries()) {
    const col = await prisma.menuItem.create({ data: { menuId: footer.id, kind: "COLUMN", label, position: i } });
    await prisma.menuItem.createMany({ data: links.map(([l, url], j) => ({ menuId: footer.id, parentId: col.id, label: l, url, position: j })) });
  }

  const legal = await prisma.navigationMenu.create({ data: { key: "footer-legal", name: "Footer legal links" } });
  await prisma.menuItem.createMany({
    data: [
      { menuId: legal.id, label: "Terms of use", url: "/terms", position: 0 },
      { menuId: legal.id, label: "Privacy", url: "/privacy", position: 1 },
      { menuId: legal.id, label: "Accessibility", url: "/accessibility", position: 2 },
    ],
  });

  const bottom = await prisma.navigationMenu.create({ data: { key: "mobile-bottom", name: "Mobile bottom navigation" } });
  await prisma.menuItem.createMany({
    data: [
      { menuId: bottom.id, label: "Home", url: "/", icon: "house", position: 0 },
      { menuId: bottom.id, label: "Categories", url: "/categories", icon: "layout-grid", position: 1 },
      { menuId: bottom.id, label: "Search", url: "/search", icon: "search", position: 2 },
      { menuId: bottom.id, label: "Watchlist", url: "/account/watchlist", icon: "heart", position: 3 },
      { menuId: bottom.id, label: "My Diau", url: "/account", icon: "user", position: 4 },
    ],
  });

  // ── Settings
  console.log("• Theme, site settings, shipping & tax");
  await prisma.themeSettings.create({ data: { id: "default", config: DEFAULT_THEME as unknown as Prisma.InputJsonValue } });
  const site = siteConfigSchema.parse({
    announcement: { enabled: true, id: "launch-2026", text: "Free standard shipping on orders over $50.", linkLabel: "Details", linkUrl: "/faq" },
    policies: {
      shipping: "Standard shipping 5–7 business days. Free on orders over $50. Express and overnight available at checkout.",
      returns: "30-day returns. Items must be in original condition. Return shipping is free for damaged or incorrect items.",
      payments: "Pay on delivery or by bank transfer. Card and wallet payments are coming soon.",
    },
    seo: { titleTemplate: "%s | Diau", defaultTitle: "Diau: buy and sell almost anything", defaultDescription: "Shop electronics, fashion, home, beauty and more on Diau. Great prices, fast shipping and easy returns.", ogImageUrl: "", allowIndexing: true },
    contact: { email: "support@diau.test", phone: "+1 (555) 010-2026", address: "100 Market St, Austin, TX 78701" },
    social: { facebook: "", instagram: "https://instagram.com/", x: "https://x.com/", tiktok: "", youtube: "" },
  });
  await prisma.siteSettings.create({ data: { id: "default", config: site as unknown as Prisma.InputJsonValue } });

  await prisma.shippingZone.create({
    data: {
      name: "United States",
      countries: ["US"],
      position: 0,
      rates: {
        create: [
          { name: "Standard", priceCents: 599, freeOverCents: 5000, etaMinDays: 5, etaMaxDays: 7, position: 0 },
          { name: "Express", priceCents: 1499, etaMinDays: 2, etaMaxDays: 3, position: 1 },
          { name: "Overnight", priceCents: 2999, etaMinDays: 1, etaMaxDays: 1, position: 2 },
        ],
      },
    },
  });
  await prisma.shippingZone.create({
    data: { name: "Canada", countries: ["CA"], position: 1, rates: { create: [{ name: "Standard", priceCents: 1299, etaMinDays: 6, etaMaxDays: 10 }] } },
  });
  await prisma.shippingZone.create({
    data: { name: "Rest of world", countries: ["*"], position: 2, rates: { create: [{ name: "International", priceCents: 2499, etaMinDays: 10, etaMaxDays: 20 }] } },
  });
  await prisma.taxRate.createMany({
    data: [
      { name: "California sales tax", country: "US", region: "CA", rateBps: 725 },
      { name: "New York sales tax", country: "US", region: "NY", rateBps: 800 },
      { name: "Texas sales tax", country: "US", region: "TX", rateBps: 625 },
      { name: "Canada GST", country: "CA", region: null, rateBps: 500 },
    ],
  });

  // ── Sample orders (dashboard data)
  console.log("• Sample orders");
  const statuses = ["DELIVERED", "DELIVERED", "DELIVERED", "SHIPPED", "PROCESSING", "CONFIRMED", "PENDING", "CANCELLED"] as const;
  for (let i = 0; i < 48; i++) {
    const customer = chance(0.7) ? pick(customers) : null;
    const lines = Array.from({ length: int(1, 3) }, () => pick(productRows));
    const items = lines.map((p) => {
      const quantity = int(1, 2);
      return { productId: p.id, title: p.title, imageUrl: p.image, unitPriceCents: p.priceCents, quantity, totalCents: p.priceCents * quantity };
    });
    const subtotalCents = items.reduce((s, it) => s + it.totalCents, 0);
    const shippingCents = subtotalCents >= 5000 ? 0 : 599;
    const taxCents = Math.round(subtotalCents * 0.0725);
    const totalCents = subtotalCents + shippingCents + taxCents;
    const status = pick(statuses);
    const placedAt = daysAgo(int(0, 60));
    const name = customer?.name ?? pick(["Guest Shopper", "Riley Cooper", "Sam Patel"]);
    await prisma.order.create({
      data: {
        userId: customer?.id ?? null,
        email: customer?.email ?? `guest${i}@example.test`,
        status,
        subtotalCents,
        shippingCents,
        taxCents,
        totalCents,
        placedAt,
        shippingAddress: { fullName: name, line1: `${int(10, 999)} Oak Ave`, city: "Austin", region: "TX", postalCode: "78701", country: "US" },
        shippingMethod: { name: "Standard", priceCents: shippingCents, etaMinDays: 5, etaMaxDays: 7 },
        items: { create: items },
        payments: {
          create: {
            provider: "manual",
            method: pick(["pay_on_delivery", "bank_transfer"]),
            status: status === "CANCELLED" ? "FAILED" : status === "PENDING" ? "PENDING" : "PAID",
            amountCents: totalCents,
          },
        },
        events: { create: [{ status: "PENDING", createdAt: placedAt }, ...(status !== "PENDING" ? [{ status, createdAt: new Date(placedAt.getTime() + 86_400_000) }] : [])] },
      },
    });
  }

  await prisma.auditLog.create({ data: { actorId: superAdmin.id, action: "seed.run", entity: "System", summary: "Seeded demo data" } });

  // Image search signatures (downloads each product's main image once). Non-fatal:
  // `npm run search:index-images` fills in anything that failed.
  console.log("• Image search index");
  const indexed = await indexProductImages({ db: prisma, concurrency: 8, log: (m) => (m.startsWith("  !") ? console.warn(m) : undefined) }).catch((err: Error) => {
    console.warn("  ! Image indexing skipped:", err.message);
    return null;
  });
  if (indexed) console.log(`  ${indexed.indexed}/${indexed.total} images indexed${indexed.failed ? `, ${indexed.failed} failed (re-run npm run search:index-images)` : ""}`);

  const counts = {
    categories: await prisma.category.count(),
    products: await prisma.product.count(),
    variants: await prisma.productVariant.count(),
    reviews: await prisma.review.count(),
    media: await prisma.mediaAsset.count(),
    orders: await prisma.order.count(),
    analyticsEvents: (await seedAnalytics(prisma)).events,
  };
  console.log("\n✔ Seed complete in", ((Date.now() - started) / 1000).toFixed(1) + "s", counts);
  console.log(`\n  Super admin: ${adminEmail} / ${adminPassword}`);
  console.log("  Admin (limited): editor@diau.test / Diau-shopper-2026!");
  console.log("  Customer:        shopper@diau.test / Diau-shopper-2026!\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
