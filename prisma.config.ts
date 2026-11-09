import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Not env("DATABASE_URL"): that throws when the variable is missing, and
    // `prisma generate` (postinstall) must work in builds without a database.
    // migrate/seed still need it; the API checks it at startup (src/env.ts).
    url: process.env.DATABASE_URL ?? "",
  },
});
