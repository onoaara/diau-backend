import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { productCardDto, productsByIds } from "../catalog/product-feed";

export const productRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Cards for specific products, in the given order. Used for "Recently viewed" (ids kept in the browser). */
  app.get(
    "/products/by-ids",
    {
      schema: {
        tags: ["storefront"],
        querystring: z.object({
          ids: z
            .string()
            .max(2000)
            .transform((s) => [...new Set(s.split(",").map((id) => id.trim()).filter(Boolean))].slice(0, 30)),
        }),
        response: { 200: z.object({ items: z.array(productCardDto) }) },
      },
    },
    async (req) => ({ items: await productsByIds(req.query.ids) }),
  );
};
