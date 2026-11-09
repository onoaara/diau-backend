import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { prisma } from "../db";

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/health",
    {
      schema: { tags: ["system"], response: { 200: z.object({ ok: z.boolean(), db: z.boolean() }) } },
    },
    async () => {
      const db = await prisma
        .$queryRaw`SELECT 1`.then(() => true)
        .catch(() => false);
      return { ok: true, db };
    },
  );
};
