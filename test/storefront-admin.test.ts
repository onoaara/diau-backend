import { describe, expect, it } from "vitest";
import { bannerInputSchema, draftInputSchema, menuDepth, menuInputSchema, sectionIssues, toPublishedSection, type DraftSection } from "../src/core";

const section = (over: Partial<DraftSection> = {}): DraftSection => ({
  id: "new-abc",
  type: "newsletter",
  name: null,
  title: "Stay in touch",
  subtitle: null,
  seeAllUrl: null,
  isVisible: true,
  device: "ALL",
  startsAt: null,
  endsAt: null,
  background: null,
  config: {},
  ...over,
});

describe("builder drafts", () => {
  it("accepts incomplete sections in a draft but reports them", () => {
    const hero = section({ type: "hero", config: { bannerIds: [] } });
    expect(draftInputSchema.safeParse({ sections: [hero] }).success).toBe(true);
    expect(sectionIssues(hero)).toEqual([{ sectionId: "new-abc", path: "config.bannerIds", message: "Add at least one banner." }]);
  });

  it("rejects duplicate section ids", () => {
    expect(draftInputSchema.safeParse({ sections: [section(), section()] }).success).toBe(false);
  });

  it("checks links, schedule order and backgrounds", () => {
    const s = section({ seeAllUrl: "javascript:alert(1)", startsAt: "2026-12-02T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z", background: { style: "color" } });
    expect(sectionIssues(s).map((i) => i.path).sort()).toEqual(["background.color", "endsAt", "seeAllUrl"]);
  });

  it("fills config defaults and trims blank text on publish", () => {
    const p = toPublishedSection(section({ title: "  ", background: { style: "none" } }));
    expect(p.title).toBeNull();
    expect(p.background).toBeNull();
    expect(p.config).toMatchObject({ buttonLabel: "Subscribe" });
  });
});

describe("banners", () => {
  const base = { name: "Spring", desktopImageId: "img1", mobileImageId: null, headline: "Spring sale", subtext: null, ctaLabel: null, linkUrl: "/deals", ctaStyle: "brand", layout: "text-left", backgroundColor: null, textTone: "dark", startsAt: null, endsAt: null, isActive: true };
  it("needs a headline unless image-only, and a link for a button", () => {
    expect(bannerInputSchema.safeParse({ ...base, headline: null }).success).toBe(false);
    expect(bannerInputSchema.safeParse({ ...base, headline: null, layout: "image-only" }).success).toBe(true);
    expect(bannerInputSchema.safeParse({ ...base, ctaLabel: "Shop", linkUrl: null }).success).toBe(false);
  });
  it("refuses unsafe links", () => {
    expect(bannerInputSchema.safeParse({ ...base, linkUrl: "javascript:alert(1)" }).success).toBe(false);
  });
});

describe("menus", () => {
  const item = (label: string, children: unknown[] = []) => ({ kind: "LINK", label, url: "/x", categoryId: null, imageId: null, description: null, icon: null, badge: null, isVisible: true, openInNewTab: false, children });
  it("parses nested items and measures depth", () => {
    const parsed = menuInputSchema.parse({ name: "Footer", items: [item("A", [item("B", [item("C")])])] });
    expect(menuDepth(parsed.items)).toBe(3);
  });
  it("requires a category for category items and a known icon", () => {
    expect(menuInputSchema.safeParse({ name: "M", items: [{ ...item("Cat"), kind: "CATEGORY" }] }).success).toBe(false);
    expect(menuInputSchema.safeParse({ name: "M", items: [{ ...item("I"), icon: "rocket" }] }).success).toBe(false);
  });
});
