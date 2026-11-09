import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  buildThemeCss,
  DEFAULT_SITE,
  DEFAULT_THEME,
  siteConfigSchema,
  TAGS,
  themeConfigInputSchema,
  themeConfigSchema,
} from "../core";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { mediaDtoSchema, mediaSelect, toMediaDto } from "../lib/media";
import { revalidateFrontend } from "../lib/revalidate";
import { requirePermission } from "../plugins/auth";

const themeResponse = z.object({
  config: themeConfigSchema,
  css: z.string(),
  logo: mediaDtoSchema.nullable(),
  logoDark: mediaDtoSchema.nullable(),
  favicon: mediaDtoSchema.nullable(),
});

async function readTheme() {
  const row = await prisma.themeSettings.findUnique({
    where: { id: "default" },
    include: {
      logo: { select: mediaSelect },
      logoDark: { select: mediaSelect },
      favicon: { select: mediaSelect },
    },
  });
  const parsed = themeConfigSchema.safeParse(row?.config ?? {});
  const config = parsed.success ? parsed.data : DEFAULT_THEME;
  return {
    config,
    css: buildThemeCss(config),
    logo: toMediaDto(row?.logo),
    logoDark: toMediaDto(row?.logoDark),
    favicon: toMediaDto(row?.favicon),
  };
}

export async function readSite() {
  const row = await prisma.siteSettings.findUnique({ where: { id: "default" } });
  const parsed = siteConfigSchema.safeParse(row?.config ?? {});
  return parsed.success ? parsed.data : DEFAULT_SITE;
}

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/settings/theme", { schema: { tags: ["settings"], response: { 200: themeResponse } } }, readTheme);
  app.get("/settings/site", { schema: { tags: ["settings"], response: { 200: siteConfigSchema } } }, readSite);

  app.put(
    "/admin/settings/theme",
    {
      preHandler: requirePermission("theme:write"),
      schema: {
        tags: ["admin"],
        body: z.object({
          config: themeConfigInputSchema,
          logoId: z.string().nullable().optional(),
          logoDarkId: z.string().nullable().optional(),
          faviconId: z.string().nullable().optional(),
        }),
        response: { 200: themeResponse },
      },
    },
    async (req) => {
      const before = await prisma.themeSettings.findUnique({ where: { id: "default" } });
      const { config, ...media } = req.body;
      const data = { config: config as Prisma.InputJsonValue, ...media };
      await prisma.themeSettings.upsert({
        where: { id: "default" },
        create: { id: "default", ...data },
        update: data,
      });
      await audit({
        actorId: req.authUser!.id,
        action: "theme.update",
        entity: "ThemeSettings",
        entityId: "default",
        summary: "Updated theme & branding",
        before: before
          ? { config: before.config, logoId: before.logoId, logoDarkId: before.logoDarkId, faviconId: before.faviconId }
          : null,
        after: { config, ...media },
        ip: req.ip,
      });
      revalidateFrontend([TAGS.theme]);
      return readTheme();
    },
  );

  app.put(
    "/admin/settings/site",
    {
      preHandler: requirePermission("settings:write"),
      schema: { tags: ["admin"], body: siteConfigSchema, response: { 200: siteConfigSchema } },
    },
    async (req) => {
      const before = await prisma.siteSettings.findUnique({ where: { id: "default" } });
      const config = req.body as Prisma.InputJsonValue;
      await prisma.siteSettings.upsert({
        where: { id: "default" },
        create: { id: "default", config },
        update: { config },
      });
      await audit({
        actorId: req.authUser!.id,
        action: "site.update",
        entity: "SiteSettings",
        entityId: "default",
        summary: "Updated site settings",
        before: (before?.config as Record<string, unknown> | undefined) ?? null,
        after: req.body,
        ip: req.ip,
      });
      revalidateFrontend([TAGS.site]);
      return readSite();
    },
  );
};
