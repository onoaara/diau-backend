import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { prisma } from "../db";

export const newsletterSchema = z.object({
  email: z.email("Enter a valid email address, like name@example.com.").max(254).transform((e) => e.trim().toLowerCase()),
  source: z.string().max(60).optional(),
});

export const newsletterRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/newsletter",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { tags: ["storefront"], body: newsletterSchema, response: { 204: z.null() } },
    },
    async (req, reply) => {
      // Same response whether or not the address was already subscribed, so the
      // form can't be used to find out who's on the list.
      await prisma.newsletterSubscriber.upsert({
        where: { email: req.body.email },
        create: { email: req.body.email, source: req.body.source ?? null },
        update: {},
      });
      return reply.code(204).send(null);
    },
  );
};
