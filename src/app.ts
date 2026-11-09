import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { env } from "./env";
import { isInternalSharedRead, rateLimitKey } from "./lib/client-ip";
import { HttpError } from "./lib/errors";
import authPlugin from "./plugins/auth";
import { adminCatalogRoutes } from "./routes/admin-catalog";
import { adminStorefrontRoutes } from "./routes/admin-storefront";
import { adminSalesRoutes } from "./routes/admin-sales";
import { authRoutes } from "./routes/auth";
import { catalogRoutes } from "./routes/catalog";
import { healthRoutes } from "./routes/health";
import { navigationRoutes } from "./routes/navigation";
import { newsletterRoutes } from "./routes/newsletter";
import { pageRoutes } from "./routes/pages";
import { productDetailRoutes } from "./routes/product";
import { productRoutes } from "./routes/products";
import { searchRoutes } from "./routes/search";
import { settingsRoutes } from "./routes/settings";
import { shoppingRoutes } from "./routes/shopping";

export type ErrorBody = { error: { code: string; message: string; fields?: Record<string, string[]> } };

export async function buildApp() {
  const app = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? { level: "info", transport: undefined }
        : { level: env.NODE_ENV === "test" ? "silent" : "info" },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });
  // Opt-in per route via `config.rateLimit` (auth, search); generous global ceiling otherwise.
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    keyGenerator: (req) => rateLimitKey(req, env.INTERNAL_API_SECRET),
    allowList: (req) => isInternalSharedRead(req, env.INTERNAL_API_SECRET),
  });

  await app.register(swagger, {
    openapi: { info: { title: "Diau API", version: "0.1.0" } },
    transform: jsonSchemaTransform,
  });
  if (env.NODE_ENV !== "production") await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(authPlugin);

  app.setErrorHandler<FastifyError>((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const fields: Record<string, string[]> = {};
      for (const issue of err.validation) {
        const key = issue.instancePath.replace(/^\//, "").replace(/\//g, ".") || "_";
        (fields[key] ??= []).push(issue.message ?? "Invalid value");
      }
      return reply
        .code(400)
        .send({ error: { code: "validation_error", message: "Check the highlighted fields.", fields } } satisfies ErrorBody);
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) },
      } satisfies ErrorBody);
    }
    if (err.statusCode === 429) {
      return reply
        .code(429)
        .send({ error: { code: "rate_limited", message: "Too many attempts. Wait a minute and try again." } } satisfies ErrorBody);
    }
    if (isResponseSerializationError(err)) req.log.error({ err: err.cause }, "response serialization failed");
    else req.log.error({ err }, "unhandled error");
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(status).send({
      error: { code: status === 500 ? "internal_error" : (err.code ?? "error"), message: status === 500 ? "Something went wrong on our side. Try again." : err.message },
    } satisfies ErrorBody);
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "Route not found." } } satisfies ErrorBody),
  );

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(settingsRoutes);
  await app.register(navigationRoutes);
  await app.register(searchRoutes);
  await app.register(pageRoutes);
  await app.register(productRoutes);
  await app.register(newsletterRoutes);
  await app.register(catalogRoutes);
  await app.register(productDetailRoutes);
  await app.register(shoppingRoutes);
  await app.register(adminCatalogRoutes);
  await app.register(adminStorefrontRoutes);
  await app.register(adminSalesRoutes);

  return app;
}
