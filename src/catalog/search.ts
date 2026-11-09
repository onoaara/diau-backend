import {
  attributeParam,
  CONDITION_LABELS,
  CONDITION_PARAMS,
  formatMoney,
  formatRange,
  parseList,
  parseRange,
  SORT_OPTIONS,
  type SortKey,
} from "../core";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { toMediaDto, mediaSelect, type MediaDto } from "../lib/media";
import { liveProductSql } from "../search/postgres";
import { imageSearch } from "../search/image-index";
import { toPrefixTsQuery } from "../search/query";
import { productsByIds, type ProductCardDto } from "./product-feed";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SearchInput = {
  /** "category" = /c/<slug> page; "search" = /search (category is then a removable scope). */
  mode: "category" | "search";
  q: string | null;
  /** Category page slug, or the `category` param on /search. */
  categorySlug: string | null;
  tag: string | null;
  /** Image-search token from /search?image=. */
  image: string | null;
  sort: SortKey;
  page: number;
  pageSize: number;
  /** Raw query parameters (filters are read from here). */
  params: Record<string, string>;
};

export type FacetDisplay = "checkbox" | "swatch" | "slider" | "toggle" | "dropdown" | "radio";

export type Facet = {
  key: string;
  param: string;
  label: string;
  display: FacetDisplay;
  collapsed: boolean;
  options: Array<{ value: string; label: string; count: number; selected: boolean; hex: string | null }>;
  range: { min: number; max: number; from: number | null; to: number | null; unit: string | null; step: number; currency: boolean } | null;
  active: boolean;
};

export type Chip = { param: string; value: string | null; label: string };

type CategoryRow = { id: string; name: string; slug: string; parentId: string | null; position: number };

type BuiltIn = "PRICE" | "BRAND" | "CONDITION" | "RATING" | "SHIPPING" | "LOCATION";
type AttrDef = {
  id: string;
  name: string;
  slug: string;
  type: "TEXT" | "NUMBER" | "SELECT" | "MULTI_SELECT" | "COLOR" | "BOOLEAN" | "RANGE";
  unit: string | null;
  values: Array<{ id: string; value: string; slug: string; swatchHex: string | null }>;
};
type FacetDef =
  | { kind: "builtin"; builtIn: BuiltIn; label: string | null; display: string; collapsed: boolean }
  | { kind: "attribute"; attr: AttrDef; label: string | null; display: string; collapsed: boolean };

const DEFAULT_BUILTINS: BuiltIn[] = ["PRICE", "BRAND", "CONDITION", "RATING", "SHIPPING"];
const BUILTIN_PARAM: Record<BuiltIn, string> = {
  PRICE: "price",
  BRAND: "brand",
  CONDITION: "condition",
  RATING: "rating",
  SHIPPING: "free_shipping",
  LOCATION: "location",
};
const BUILTIN_LABEL: Record<BuiltIn, string> = {
  PRICE: "Price",
  BRAND: "Brand",
  CONDITION: "Condition",
  RATING: "Customer rating",
  SHIPPING: "Shipping",
  LOCATION: "Item location",
};
const MAX_IMAGE_MATCHES = 48;

// ── SQL building blocks ───────────────────────────────────────────────────────

/**
 * Shopper-facing price in SQL. MUST match core/pricing.ts `effectivePrice`
 * (lowest active promotion price, never above the base price). A test compares
 * the two over the whole catalog.
 */
export const promoJoin = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT
      MIN(CASE
            WHEN pp."specialPriceCents" IS NOT NULL THEN GREATEST(0, pp."specialPriceCents")
            WHEN pr."discountType" = 'PERCENT' THEN GREATEST(0, p."priceCents" - ROUND(p."priceCents"::numeric * pr.value / 10000)::int)
            WHEN pr."discountType" = 'FIXED' THEN GREATEST(0, p."priceCents" - pr.value)
            ELSE p."priceCents"
          END) AS price,
      BOOL_OR(pr."discountType" = 'FREE_SHIPPING') AS free_ship,
      MIN(pr."endsAt") AS ends_at
    FROM "PromotionProduct" pp
    JOIN "Promotion" pr ON pr.id = pp."promotionId"
    WHERE pp."productId" = p.id AND pr."isActive" AND pr."startsAt" <= now() AND pr."endsAt" > now()
  ) promo ON true`;

function baseCte(opts: {
  scope: string[] | null;
  q: { text: string; prefix: string } | null;
  tag: string | null;
  ids: string[] | null;
}): Prisma.Sql {
  const conds: Prisma.Sql[] = [liveProductSql];
  if (opts.scope) conds.push(Prisma.sql`p."categoryId" = ANY(${opts.scope}::text[])`);
  if (opts.q) {
    conds.push(Prisma.sql`(p."searchVector" @@ websearch_to_tsquery('english', ${opts.q.text})
      OR p."searchVector" @@ to_tsquery('simple', ${opts.q.prefix}))`);
  }
  if (opts.tag) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "_ProductToTag" pt JOIN "Tag" t ON t.id = pt."B" WHERE pt."A" = p.id AND t.slug = ${opts.tag})`);
  }
  if (opts.ids) conds.push(Prisma.sql`p.id = ANY(${opts.ids}::text[])`);

  const rank = opts.ids
    ? Prisma.sql`-array_position(${opts.ids}::text[], p.id)::float`
    : opts.q
      ? Prisma.sql`(ts_rank_cd(p."searchVector", websearch_to_tsquery('english', ${opts.q.text}))
          + 0.5 * ts_rank(p."searchVector", to_tsquery('simple', ${opts.q.prefix}))
          + similarity(p.title, ${opts.q.text}))`
      : Prisma.sql`0::float`;

  return Prisma.sql`WITH base AS (
    SELECT p.id, p."categoryId", p."brandId", p.condition::text AS condition, p.location,
           p."ratingAvg", p."ratingCount", p."soldCount", p."createdAt",
           LEAST(p."priceCents", COALESCE(promo.price, p."priceCents")) AS eff_price,
           (p."freeShipping" OR COALESCE(promo.free_ship, false)) AS free_ship,
           promo.ends_at,
           ${rank} AS rank
    FROM "Product" p
    ${promoJoin}
    WHERE ${Prisma.join(conds, " AND ")}
  )`;
}

function orderBy(sort: SortKey, hasRank: boolean): Prisma.Sql {
  switch (sort) {
    case "price_asc":
      return Prisma.sql`b.eff_price ASC, b.id`;
    case "price_desc":
      return Prisma.sql`b.eff_price DESC, b.id`;
    case "newest":
      return Prisma.sql`b."createdAt" DESC, b.id`;
    case "rating":
      return Prisma.sql`b."ratingAvg" DESC, b."ratingCount" DESC, b.id`;
    case "ending":
      return Prisma.sql`b.ends_at ASC NULLS LAST, b."soldCount" DESC, b.id`;
    case "best":
      return hasRank
        ? Prisma.sql`b.rank DESC, b."soldCount" DESC, b.id`
        : Prisma.sql`b."soldCount" DESC, b."ratingAvg" DESC, b.id`;
  }
}

const attrExists = (attrId: string, cond: Prisma.Sql) =>
  Prisma.sql`EXISTS (SELECT 1 FROM "ProductAttribute" pa WHERE pa."productId" = b.id AND pa."attributeId" = ${attrId} AND ${cond})`;

/** Rounds slider bounds to the step's precision (avoids 16.900000000000002). */
const roundTo = (n: number, step: number) => Number(n.toFixed(step < 1 ? 1 : 0));

// ── Category tree helpers ─────────────────────────────────────────────────────

function treeHelpers(rows: CategoryRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string | null, CategoryRow[]>();
  for (const r of rows) {
    const list = children.get(r.parentId) ?? [];
    list.push(r);
    children.set(r.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position);
  const descendants = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap((c) => descendants(c.id))];
  const ancestors = (id: string): CategoryRow[] => {
    const out: CategoryRow[] = [];
    for (let cur = byId.get(id)?.parentId ?? null, guard = 0; cur && guard < 10; guard++) {
      const row = byId.get(cur);
      if (!row) break;
      out.unshift(row);
      cur = row.parentId;
    }
    return out;
  };
  return { byId, children: (id: string | null) => children.get(id) ?? [], descendants, ancestors };
}

// ── Facet definitions ─────────────────────────────────────────────────────────

async function facetDefinitions(category: CategoryRow | null, ancestors: CategoryRow[]): Promise<FacetDef[]> {
  if (!category) {
    return DEFAULT_BUILTINS.map((b, i) => ({
      kind: "builtin" as const,
      builtIn: b,
      label: null,
      display: b === "PRICE" ? "SLIDER" : b === "SHIPPING" ? "TOGGLE" : "CHECKBOX",
      collapsed: i > 3,
    }));
  }
  // The category's own filters plus inherited ones from ancestors; the nearest definition wins.
  const chain = [category, ...[...ancestors].reverse()];
  const rows = await prisma.categoryAttribute.findMany({
    where: { categoryId: { in: chain.map((c) => c.id) } },
    select: {
      categoryId: true,
      builtIn: true,
      label: true,
      displayType: true,
      position: true,
      isCollapsed: true,
      inheritToChildren: true,
      attribute: {
        select: {
          id: true,
          name: true,
          slug: true,
          type: true,
          unit: true,
          isFilterable: true,
          values: { orderBy: { position: "asc" }, select: { id: true, value: true, slug: true, swatchHex: true } },
        },
      },
    },
  });
  const depth = new Map(chain.map((c, i) => [c.id, i]));
  const chosen = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const d = depth.get(r.categoryId) ?? 99;
    if (d > 0 && !r.inheritToChildren) continue;
    if (r.attribute && !r.attribute.isFilterable) continue;
    const key = r.builtIn ?? r.attribute?.id;
    if (!key) continue;
    const prev = chosen.get(key);
    if (!prev || (depth.get(prev.categoryId) ?? 99) > d) chosen.set(key, r);
  }
  return [...chosen.values()]
    .sort((a, b) => a.position - b.position)
    .map((r): FacetDef =>
      r.builtIn
        ? { kind: "builtin", builtIn: r.builtIn, label: r.label, display: r.displayType, collapsed: r.isCollapsed }
        : { kind: "attribute", attr: r.attribute!, label: r.label, display: r.displayType, collapsed: r.isCollapsed },
    );
}

function facetKey(def: FacetDef): string {
  return def.kind === "builtin" ? BUILTIN_PARAM[def.builtIn] : attributeParam(def.attr.slug);
}

function displayFor(def: FacetDef): FacetDisplay {
  if (def.kind === "builtin") {
    if (def.builtIn === "PRICE") return "slider";
    if (def.builtIn === "SHIPPING") return "toggle";
    if (def.builtIn === "RATING") return "radio";
    if (def.builtIn === "LOCATION") return "dropdown";
    return def.display === "DROPDOWN" ? "dropdown" : "checkbox";
  }
  const t = def.attr.type;
  if (t === "BOOLEAN") return "toggle";
  if (t === "RANGE" || t === "NUMBER") return "slider";
  if (def.display === "SWATCH" && t === "COLOR") return "swatch";
  if (def.display === "DROPDOWN") return "dropdown";
  return "checkbox";
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function searchCatalog(input: SearchInput, money: { currency: string; locale: string }) {
  const allCategories = await prisma.category.findMany({
    where: { isVisible: true },
    select: { id: true, name: true, slug: true, parentId: true, position: true },
  });
  const tree = treeHelpers(allCategories);

  // Category
  const category = input.categorySlug ? (allCategories.find((c) => c.slug === input.categorySlug) ?? null) : null;
  if (input.categorySlug && !category) return { notFound: true as const };
  const ancestors = category ? tree.ancestors(category.id) : [];
  const scope = category ? tree.descendants(category.id) : null;

  // Query
  const text = input.q?.trim().slice(0, 200) || null;
  const prefix = text ? toPrefixTsQuery(text) : null;
  const q = text && prefix ? { text, prefix } : null;

  // Tag
  const tag = input.tag ? await prisma.tag.findUnique({ where: { slug: input.tag }, select: { slug: true, name: true } }) : null;

  // Image search: rank the scope by visual similarity, then treat the top matches as the result set.
  let imageState: { token: string; expired: boolean } | null = null;
  let imageIds: string[] | null = null;
  if (input.image) {
    const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
      ${baseCte({ scope, q, tag: tag?.slug ?? null, ids: null })}
      SELECT b.id FROM base b LIMIT 5000`;
    const ranked = await imageSearch.rank(input.image, candidates.map((c) => c.id));
    imageState = { token: input.image, expired: ranked === null };
    imageIds = (ranked ?? []).slice(0, MAX_IMAGE_MATCHES);
  }

  const cte = baseCte({ scope, q, tag: tag?.slug ?? null, ids: imageIds });
  const defs = await facetDefinitions(category, ancestors);

  // Parse filters → SQL conditions (by facet key) + chips.
  const conditions = new Map<string, Prisma.Sql>();
  const chips: Chip[] = [];
  const selected = new Map<string, Set<string>>();
  const ranges = new Map<string, { from: number | null; to: number | null }>();
  const fmtMoney = (dollars: number) => formatMoney(Math.round(dollars * 100), money.currency, money.locale).replace(/\.00$/, "");

  const hasBrandFacet = defs.some((d) => d.kind === "builtin" && d.builtIn === "BRAND");
  const brandSlugs = hasBrandFacet ? parseList(input.params.brand) : [];
  const brands = brandSlugs.length
    ? await prisma.brand.findMany({ where: { slug: { in: brandSlugs } }, select: { id: true, slug: true, name: true } })
    : [];

  for (const def of defs) {
    const key = facetKey(def);
    const raw = input.params[key];
    if (!raw) continue;
    const label = def.label ?? (def.kind === "builtin" ? BUILTIN_LABEL[def.builtIn] : def.attr.name);
    if (def.kind === "builtin") {
      switch (def.builtIn) {
        case "PRICE": {
          const r = parseRange(raw);
          if (!r) break;
          const parts: Prisma.Sql[] = [];
          if (r.from !== null) parts.push(Prisma.sql`b.eff_price >= ${Math.round(r.from * 100)}`);
          if (r.to !== null) parts.push(Prisma.sql`b.eff_price <= ${Math.round(r.to * 100)}`);
          conditions.set(key, Prisma.join(parts, " AND "));
          ranges.set(key, r);
          chips.push({ param: key, value: null, label: `${label}: ${formatRange(r.from, r.to, fmtMoney)}` });
          break;
        }
        case "BRAND": {
          if (!brands.length) break;
          conditions.set(key, Prisma.sql`b."brandId" = ANY(${brands.map((b) => b.id)}::text[])`);
          selected.set(key, new Set(brands.map((b) => b.slug)));
          for (const b of brands) chips.push({ param: key, value: b.slug, label: `${label}: ${b.name}` });
          break;
        }
        case "CONDITION": {
          const values = parseList(raw).filter((v): v is keyof typeof CONDITION_PARAMS => v in CONDITION_PARAMS);
          if (!values.length) break;
          conditions.set(key, Prisma.sql`b.condition = ANY(${values.map((v) => CONDITION_PARAMS[v])}::text[])`);
          selected.set(key, new Set(values));
          for (const v of values) chips.push({ param: key, value: v, label: `${label}: ${CONDITION_LABELS[CONDITION_PARAMS[v]]}` });
          break;
        }
        case "RATING": {
          const n = Number(raw);
          if (![1, 2, 3, 4].includes(n)) break;
          conditions.set(key, Prisma.sql`b."ratingAvg" >= ${n}`);
          selected.set(key, new Set([String(n)]));
          chips.push({ param: key, value: null, label: `${n}★ & up` });
          break;
        }
        case "SHIPPING": {
          if (raw !== "1") break;
          conditions.set(key, Prisma.sql`b.free_ship`);
          selected.set(key, new Set(["1"]));
          chips.push({ param: key, value: null, label: "Free shipping" });
          break;
        }
        case "LOCATION": {
          const loc = raw.slice(0, 100);
          conditions.set(key, Prisma.sql`b.location = ${loc}`);
          selected.set(key, new Set([loc]));
          chips.push({ param: key, value: null, label: `${label}: ${loc}` });
          break;
        }
      }
      continue;
    }
    const attr = def.attr;
    if (attr.type === "BOOLEAN") {
      if (raw !== "1") continue;
      conditions.set(key, attrExists(attr.id, Prisma.sql`pa."booleanValue" = true`));
      selected.set(key, new Set(["1"]));
      chips.push({ param: key, value: null, label });
    } else if (attr.type === "RANGE" || attr.type === "NUMBER") {
      const r = parseRange(raw);
      if (!r) continue;
      const parts: Prisma.Sql[] = [];
      if (r.from !== null) parts.push(Prisma.sql`pa."numberValue" >= ${r.from}`);
      if (r.to !== null) parts.push(Prisma.sql`pa."numberValue" <= ${r.to}`);
      conditions.set(key, attrExists(attr.id, Prisma.join(parts, " AND ")));
      ranges.set(key, r);
      const unit = attr.unit ? ` ${attr.unit}` : "";
      chips.push({ param: key, value: null, label: `${label}: ${formatRange(r.from, r.to, (n) => `${n}${unit}`)}` });
    } else {
      const slugs = parseList(raw);
      const values = attr.values.filter((v) => slugs.includes(v.slug));
      if (!values.length) continue;
      conditions.set(key, attrExists(attr.id, Prisma.sql`pa."valueId" = ANY(${values.map((v) => v.id)}::text[])`));
      selected.set(key, new Set(values.map((v) => v.slug)));
      for (const v of values) chips.push({ param: key, value: v.slug, label: `${label}: ${v.value}` });
    }
  }

  // On /search a category is just a scope: show it as a removable chip.
  if (input.mode === "search" && category) chips.unshift({ param: "category", value: null, label: `Category: ${category.name}` });
  if (tag) chips.unshift({ param: "tag", value: null, label: `Tag: ${tag.name}` });

  const whereExcept = (skip: string | null) => {
    const parts = [...conditions.entries()].filter(([k]) => k !== skip).map(([, v]) => v);
    return parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`TRUE`;
  };
  const whereAll = whereExcept(null);

  const pageSize = input.pageSize;
  const [countRows, idRows] = await Promise.all([
    prisma.$queryRaw<Array<{ n: number }>>`${cte} SELECT COUNT(*)::int AS n FROM base b WHERE ${whereAll}`,
    prisma.$queryRaw<Array<{ id: string }>>`${cte}
      SELECT b.id FROM base b WHERE ${whereAll}
      ORDER BY ${orderBy(input.sort, Boolean(q) || Boolean(imageIds))}
      LIMIT ${pageSize} OFFSET ${(input.page - 1) * pageSize}`,
  ]);
  const total = countRows[0]?.n ?? 0;

  // Facet counts (each ignores its own selection: disjunctive faceting).
  const facets = await Promise.all(
    defs.map((def) =>
      buildFacet(def, cte, whereExcept(facetKey(def)), selected.get(facetKey(def)) ?? new Set(), ranges.get(facetKey(def)) ?? null),
    ),
  );

  // Sub-category counts (with all filters applied).
  const scopeChildren = tree.children(category?.id ?? null);
  const perCategory = await prisma.$queryRaw<Array<{ id: string; n: number }>>`${cte}
    SELECT b."categoryId" AS id, COUNT(*)::int AS n FROM base b WHERE ${whereAll} GROUP BY 1`;
  const countByCategory = new Map(perCategory.map((r) => [r.id, r.n]));
  const subcategories = scopeChildren
    .map((c) => ({ name: c.name, slug: c.slug, count: tree.descendants(c.id).reduce((sum, id) => sum + (countByCategory.get(id) ?? 0), 0) }))
    .filter((c) => c.count > 0);

  const items = await productsByIds(idRows.map((r) => r.id));
  const suggestion = total === 0 && text ? await spellingSuggestion(text) : null;

  const categoryDetail = category
    ? await prisma.category.findUnique({
        where: { id: category.id },
        select: { description: true, seoTitle: true, seoDescription: true, banner: { select: mediaSelect } },
      })
    : null;

  return {
    notFound: false as const,
    query: { q: text, suggestion, image: imageState },
    tag,
    category: category
      ? {
          id: category.id,
          name: category.name,
          slug: category.slug,
          description: categoryDetail?.description ?? null,
          seoTitle: categoryDetail?.seoTitle ?? null,
          seoDescription: categoryDetail?.seoDescription ?? null,
          banner: toMediaDto(categoryDetail?.banner) as MediaDto | null,
          breadcrumbs: ancestors.map((a) => ({ name: a.name, slug: a.slug })),
        }
      : null,
    subcategories,
    facets: facets.filter((f): f is Facet => f !== null),
    chips,
    sort: input.sort,
    sortOptions: SORT_OPTIONS.map((o) => ({ ...o })),
    items: items as ProductCardDto[],
    total,
    page: input.page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function buildFacet(
  def: FacetDef,
  cte: Prisma.Sql,
  where: Prisma.Sql,
  selected: Set<string>,
  range: { from: number | null; to: number | null } | null,
): Promise<Facet | null> {
  const key = facetKey(def);
  const display = displayFor(def);
  const label = def.label ?? (def.kind === "builtin" ? BUILTIN_LABEL[def.builtIn] : def.attr.name);
  const base = { key, param: key, label, display, collapsed: def.collapsed };
  const opt = (value: string, text: string, count: number, hex: string | null = null) => ({
    value,
    label: text,
    count,
    selected: selected.has(value),
    hex,
  });
  // Keep selected options visible even when other filters drop their count to zero.
  const keep = <T extends { count: number; selected: boolean }>(list: T[]) => list.filter((o) => o.count > 0 || o.selected);

  if (def.kind === "builtin") {
    switch (def.builtIn) {
      case "PRICE": {
        const [r] = await prisma.$queryRaw<Array<{ min: number | null; max: number | null }>>`${cte}
          SELECT MIN(b.eff_price)::int AS min, MAX(b.eff_price)::int AS max FROM base b WHERE ${where}`;
        if (r?.min == null || r.max == null) return null;
        const min = Math.floor(r.min / 100);
        const max = Math.ceil(r.max / 100);
        if (min === max && !range) return null;
        return {
          ...base,
          options: [],
          range: { min, max, from: range?.from ?? null, to: range?.to ?? null, unit: null, step: 1, currency: true },
          active: Boolean(range),
        };
      }
      case "BRAND": {
        const rows = await prisma.$queryRaw<Array<{ id: string; n: number }>>`${cte}
          SELECT b."brandId" AS id, COUNT(*)::int AS n FROM base b WHERE ${where} AND b."brandId" IS NOT NULL GROUP BY 1`;
        const counts = new Map(rows.map((r) => [r.id, r.n]));
        const brands = await prisma.brand.findMany({
          where: { OR: [{ id: { in: [...counts.keys()] } }, { slug: { in: [...selected] } }] },
          select: { id: true, slug: true, name: true },
        });
        const options = keep(brands.map((b) => opt(b.slug, b.name, counts.get(b.id) ?? 0))).sort(
          (a, b) => Number(b.selected) - Number(a.selected) || b.count - a.count || a.label.localeCompare(b.label),
        );
        return options.length ? { ...base, options, range: null, active: selected.size > 0 } : null;
      }
      case "CONDITION": {
        const rows = await prisma.$queryRaw<Array<{ c: string; n: number }>>`${cte}
          SELECT b.condition AS c, COUNT(*)::int AS n FROM base b WHERE ${where} GROUP BY 1`;
        const counts = new Map(rows.map((r) => [r.c, r.n]));
        const entries = Object.entries(CONDITION_PARAMS) as Array<[keyof typeof CONDITION_PARAMS, keyof typeof CONDITION_LABELS]>;
        const options = keep(entries.map(([param, enumValue]) => opt(param, CONDITION_LABELS[enumValue], counts.get(enumValue) ?? 0)));
        return options.length ? { ...base, options, range: null, active: selected.size > 0 } : null;
      }
      case "RATING": {
        const [r] = await prisma.$queryRaw<Array<{ r4: number; r3: number; r2: number; r1: number }>>`${cte}
          SELECT COUNT(*) FILTER (WHERE b."ratingAvg" >= 4)::int AS r4, COUNT(*) FILTER (WHERE b."ratingAvg" >= 3)::int AS r3,
                 COUNT(*) FILTER (WHERE b."ratingAvg" >= 2)::int AS r2, COUNT(*) FILTER (WHERE b."ratingAvg" >= 1)::int AS r1
          FROM base b WHERE ${where}`;
        if (!r) return null;
        const options = keep([opt("4", "4★ & up", r.r4), opt("3", "3★ & up", r.r3), opt("2", "2★ & up", r.r2), opt("1", "1★ & up", r.r1)]);
        return options.length ? { ...base, options, range: null, active: selected.size > 0 } : null;
      }
      case "SHIPPING": {
        const [r] = await prisma.$queryRaw<Array<{ n: number }>>`${cte}
          SELECT COUNT(*) FILTER (WHERE b.free_ship)::int AS n FROM base b WHERE ${where}`;
        const n = r?.n ?? 0;
        if (!n && !selected.size) return null;
        return { ...base, options: [opt("1", "Free shipping", n)], range: null, active: selected.size > 0 };
      }
      case "LOCATION": {
        const rows = await prisma.$queryRaw<Array<{ loc: string; n: number }>>`${cte}
          SELECT b.location AS loc, COUNT(*)::int AS n FROM base b WHERE ${where} AND b.location IS NOT NULL GROUP BY 1 ORDER BY 1`;
        const options = keep(rows.map((r) => opt(r.loc, r.loc, r.n)));
        for (const s of selected) if (!options.some((o) => o.value === s)) options.push(opt(s, s, 0));
        return options.length ? { ...base, options, range: null, active: selected.size > 0 } : null;
      }
    }
  }

  const attr = def.attr;
  if (attr.type === "BOOLEAN") {
    const [r] = await prisma.$queryRaw<Array<{ n: number }>>`${cte}
      SELECT COUNT(*)::int AS n FROM base b WHERE ${where} AND ${attrExists(attr.id, Prisma.sql`pa."booleanValue" = true`)}`;
    if (!r?.n && !selected.size) return null;
    return { ...base, options: [opt("1", attr.name, r?.n ?? 0)], range: null, active: selected.size > 0 };
  }
  if (attr.type === "RANGE" || attr.type === "NUMBER") {
    const [r] = await prisma.$queryRaw<Array<{ min: number | null; max: number | null; frac: boolean | null }>>`${cte}
      SELECT MIN(pa."numberValue") AS min, MAX(pa."numberValue") AS max, BOOL_OR(pa."numberValue" <> TRUNC(pa."numberValue")) AS frac
      FROM base b JOIN "ProductAttribute" pa ON pa."productId" = b.id AND pa."attributeId" = ${attr.id}
      WHERE ${where}`;
    if (r?.min == null || r.max == null || (r.min === r.max && !range)) return null;
    const step = r.frac ? 0.1 : 1;
    return {
      ...base,
      options: [],
      range: {
        min: roundTo(Math.floor(r.min / step) * step, step),
        max: roundTo(Math.ceil(r.max / step) * step, step),
        from: range?.from ?? null,
        to: range?.to ?? null,
        unit: attr.unit,
        step,
        currency: false,
      },
      active: Boolean(range),
    };
  }
  const rows = await prisma.$queryRaw<Array<{ id: string; n: number }>>`${cte}
    SELECT pa."valueId" AS id, COUNT(DISTINCT b.id)::int AS n
    FROM base b JOIN "ProductAttribute" pa ON pa."productId" = b.id AND pa."attributeId" = ${attr.id}
    WHERE ${where} AND pa."valueId" IS NOT NULL GROUP BY 1`;
  const counts = new Map(rows.map((r) => [r.id, r.n]));
  const options = keep(attr.values.map((v) => opt(v.slug, v.value, counts.get(v.id) ?? 0, v.swatchHex)));
  return options.length ? { ...base, options, range: null, active: selected.size > 0 } : null;
}

/**
 * "Did you mean": replaces each unknown word with the closest word in product
 * titles or category names. Candidates come from trigram similarity, ranked by
 * edit distance (fuzzystrmatch), so transpositions like "iphnoe" work.
 * Null when nothing changes.
 */
async function spellingSuggestion(text: string): Promise<string | null> {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 6) ?? [];
  if (!tokens.length) return null;
  let changed = false;
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length < 3) {
      out.push(token);
      continue;
    }
    const maxEdits = token.length <= 4 ? 1 : 2;
    const [best] = await prisma.$queryRaw<Array<{ w: string; d: number }>>`
      SELECT w, levenshtein(w, ${token}) AS d FROM (
        SELECT DISTINCT lower(unnest(regexp_split_to_array(title, '[^[:alnum:]]+'))) AS w FROM "Product" WHERE status = 'ACTIVE'
        UNION SELECT DISTINCT lower(unnest(regexp_split_to_array(name, '[^[:alnum:]]+'))) FROM "Category" WHERE "isVisible"
      ) words
      WHERE length(w) > 2 AND similarity(w, ${token}) >= 0.15
      ORDER BY levenshtein(w, ${token}), similarity(w, ${token}) DESC
      LIMIT 1`;
    if (best && best.d > 0 && best.d <= maxEdits) {
      out.push(best.w);
      changed = true;
    } else out.push(token);
  }
  return changed ? out.join(" ") : null;
}
