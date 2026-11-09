import { draftSectionSchema, SECTION_META, sectionIssues, toPublishedSection, type DraftSection, type SectionIssue } from "../core";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { HttpError, notFound } from "../lib/errors";
import { mediaSelect, toMediaDto } from "../lib/media";
import { renderSections, type RenderableSection } from "../routes/pages";

const sectionSelect = {
  id: true,
  type: true,
  name: true,
  title: true,
  subtitle: true,
  seeAllUrl: true,
  config: true,
  background: true,
  position: true,
  isVisible: true,
  device: true,
  startsAt: true,
  endsAt: true,
} as const;

type SectionRow = Prisma.SectionGetPayload<{ select: typeof sectionSelect }>;

function rowToDraft(r: SectionRow): DraftSection {
  const bg = r.background as DraftSection["background"];
  return {
    id: r.id,
    type: r.type as DraftSection["type"],
    name: r.name,
    title: r.title,
    subtitle: r.subtitle,
    seeAllUrl: r.seeAllUrl,
    isVisible: r.isVisible,
    device: r.device,
    startsAt: r.startsAt?.toISOString() ?? null,
    endsAt: r.endsAt?.toISOString() ?? null,
    background: bg && typeof bg === "object" ? bg : null,
    config: (r.config && typeof r.config === "object" ? r.config : {}) as Record<string, unknown>,
  };
}

/** Draft JSON from the DB, keeping only entries that still parse (types may have been removed). */
function parseDraft(raw: unknown): DraftSection[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((s) => {
    const p = draftSectionSchema.safeParse(s);
    return p.success ? [p.data] : [];
  });
}

const allIssues = (sections: DraftSection[]): SectionIssue[] => sections.flatMap(sectionIssues);

export async function listPages() {
  const rows = await prisma.page.findMany({
    orderBy: [{ kind: "asc" }, { title: "asc" }],
    select: { id: true, slug: true, title: true, kind: true, status: true, publishedAt: true, updatedAt: true, draftUpdatedAt: true, _count: { select: { sections: true } } },
  });
  return rows.map(({ _count, ...p }) => ({ ...p, hasDraft: p.draftUpdatedAt !== null, sectionCount: _count.sections }));
}

/** The builder's working copy: the draft when there is one, otherwise the published sections. */
export async function readPageForBuilder(id: string) {
  const p = await prisma.page.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      title: true,
      kind: true,
      status: true,
      seoTitle: true,
      seoDescription: true,
      publishedAt: true,
      draft: true,
      draftUpdatedAt: true,
      draftUpdatedBy: true,
      sections: { orderBy: { position: "asc" }, select: sectionSelect },
    },
  });
  if (!p) return null;
  const draft = parseDraft(p.draft);
  const sections = draft ?? p.sections.map(rowToDraft);
  const editor = p.draftUpdatedBy ? await prisma.user.findUnique({ where: { id: p.draftUpdatedBy }, select: { name: true, email: true } }) : null;
  const { draft: _raw, sections: _rows, draftUpdatedBy: _by, ...meta } = p;
  return {
    ...meta,
    hasDraft: draft !== null,
    draftUpdatedByName: editor ? (editor.name ?? editor.email) : null,
    sections,
    issues: allIssues(sections),
  };
}

export async function saveDraft(id: string, sections: DraftSection[], userId: string | null) {
  const page = await prisma.page.findUnique({ where: { id }, select: { id: true } });
  if (!page) throw notFound("Page");
  const updated = await prisma.page.update({
    where: { id },
    data: { draft: sections as unknown as Prisma.InputJsonValue, draftUpdatedAt: new Date(), draftUpdatedBy: userId },
    select: { draftUpdatedAt: true },
  });
  return { draftUpdatedAt: updated.draftUpdatedAt!.toISOString(), issues: allIssues(sections) };
}

export async function discardDraft(id: string) {
  const page = await prisma.page.findUnique({ where: { id }, select: { id: true, slug: true } });
  if (!page) throw notFound("Page");
  await prisma.page.update({ where: { id }, data: { draft: Prisma.DbNull, draftUpdatedAt: null, draftUpdatedBy: null } });
  return page;
}

/**
 * Publishes the draft: existing sections are updated in place (their ids stay,
 * so "Load more" links keep working), new ones created, removed ones deleted.
 */
export async function publishPage(id: string) {
  const page = await prisma.page.findUnique({ where: { id }, select: { id: true, slug: true, title: true, draft: true, sections: { select: { id: true } } } });
  if (!page) throw notFound("Page");
  const draft = parseDraft(page.draft);
  if (!draft) return { slug: page.slug, title: page.title, changed: false };

  const issues = allIssues(draft);
  if (issues.length) {
    const fields: Record<string, string[]> = {};
    for (const i of issues) (fields[`sections.${i.sectionId}.${i.path}`] ??= []).push(i.message);
    throw new HttpError(422, "validation_error", `Fix ${issues.length === 1 ? "1 problem" : `${issues.length} problems`} before publishing.`, fields);
  }

  const existing = new Set(page.sections.map((s) => s.id));
  const keep = new Set(draft.map((s) => s.id).filter((sid) => existing.has(sid)));
  await prisma.$transaction(async (tx) => {
    await tx.section.deleteMany({ where: { pageId: id, id: { notIn: [...keep] } } });
    for (const [position, s] of draft.entries()) {
      const data = toPublishedSection(s);
      const row = { ...data, position, config: data.config as Prisma.InputJsonValue, background: (data.background ?? Prisma.DbNull) as Prisma.InputJsonValue };
      if (keep.has(s.id)) await tx.section.update({ where: { id: s.id }, data: row });
      else await tx.section.create({ data: { ...row, pageId: id } });
    }
    await tx.page.update({ where: { id }, data: { status: "PUBLISHED", publishedAt: new Date(), draft: Prisma.DbNull, draftUpdatedAt: null, draftUpdatedBy: null } });
  });
  return { slug: page.slug, title: page.title, changed: true, sectionCount: draft.length };
}

export async function updatePageMeta(id: string, input: { title: string; seoTitle: string | null; seoDescription: string | null }) {
  const page = await prisma.page.findUnique({ where: { id }, select: { slug: true, title: true, seoTitle: true, seoDescription: true } });
  if (!page) throw notFound("Page");
  await prisma.page.update({ where: { id }, data: input });
  return { before: page, slug: page.slug };
}

/**
 * Renders the working copy as shoppers would see it at `at` (default now).
 * Also reports sections that won't show and why.
 */
export async function previewPage(id: string, source: "draft" | "published", at: Date, log: (m: string) => void) {
  const p = await prisma.page.findUnique({
    where: { id },
    select: { slug: true, title: true, kind: true, seoTitle: true, seoDescription: true, draft: true, sections: { orderBy: { position: "asc" }, select: sectionSelect } },
  });
  if (!p) return null;
  const draft = source === "draft" ? parseDraft(p.draft) : null;
  const working = draft ?? p.sections.map(rowToDraft);
  const rows: Array<RenderableSection & { isVisible: boolean }> = working.map((s) => ({
    id: s.id,
    type: s.type,
    title: s.title?.trim() || null,
    subtitle: s.subtitle?.trim() || null,
    seeAllUrl: s.seeAllUrl ?? null,
    config: s.config,
    background: s.background ?? null,
    device: s.device,
    isVisible: s.isVisible,
    startsAt: s.startsAt ? new Date(s.startsAt) : null,
    endsAt: s.endsAt ? new Date(s.endsAt) : null,
  }));
  const { sections, skipped } = await renderSections(rows, at, log);
  const names = new Map(working.map((s) => [s.id, s.name || s.title || SECTION_META[s.type].label]));
  const { draft: _d, sections: _s, ...page } = p;
  return { page, sections, skipped: skipped.map((s) => ({ ...s, name: names.get(s.id) ?? s.id })), at: at.toISOString(), source: draft ? "draft" : "published" };
}

// ── Reference data for section forms ─────────────────────────────────────────

export async function builderReference() {
  const now = new Date();
  const [banners, categories, brands, promotions, tags] = await Promise.all([
    prisma.banner.findMany({ orderBy: { updatedAt: "desc" }, select: { id: true, name: true, headline: true, isActive: true, startsAt: true, endsAt: true, desktopImage: { select: mediaSelect } } }),
    prisma.category.findMany({ orderBy: { position: "asc" }, select: { id: true, name: true, parentId: true, position: true, isVisible: true } }),
    prisma.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, isFeatured: true } }),
    prisma.promotion.findMany({ orderBy: { startsAt: "desc" }, select: { id: true, name: true, isActive: true, startsAt: true, endsAt: true } }),
    prisma.tag.findMany({ orderBy: { name: "asc" }, take: 300, select: { slug: true, name: true } }),
  ]);
  return {
    banners: banners.map(({ desktopImage, ...b }) => ({ ...b, image: toMediaDto(desktopImage), live: b.isActive && (!b.startsAt || b.startsAt <= now) && (!b.endsAt || b.endsAt > now) })),
    categories,
    brands,
    promotions: promotions.map((p) => ({ ...p, live: p.isActive && p.startsAt <= now && p.endsAt > now })),
    tags,
    sectionTypes: Object.entries(SECTION_META).map(([type, m]) => ({ type, ...m })),
  };
}
