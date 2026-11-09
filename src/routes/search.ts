import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { search } from "../search";

const suggestionsResponse = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      slug: z.string(),
      priceCents: z.number().int(),
      compareAtPriceCents: z.number().int().nullable(),
      image: z.object({ url: z.string(), alt: z.string() }).nullable(),
    }),
  ),
  categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), parentName: z.string().nullable() })),
});

export const searchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/search/suggest",
    {
      // Fires as shoppers type (debounced 150ms); still cap it per IP.
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
      schema: {
        tags: ["storefront"],
        querystring: z.object({
          q: z.string().trim().min(1).max(100),
          category: z.string().regex(/^[a-z0-9-]{1,100}$/).optional(),
          limit: z.coerce.number().int().min(1).max(10).default(6),
        }),
        response: { 200: suggestionsResponse },
      },
    },
    async (req) => search.suggest(req.query),
  );
};
