import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const SECRET = "s".repeat(40);
let app: FastifyInstance;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused@localhost:1/unused",
    API_JWT_SECRET: "j".repeat(40),
    REVALIDATE_SECRET: "r".repeat(20),
    INTERNAL_API_SECRET: SECRET,
  });
  const { buildApp } = await import("../src/app");
  app = await buildApp();
});
afterAll(() => app?.close());

/** Invalid login bodies are rejected (400) before touching the DB but still count toward the limit. */
const login = (headers: Record<string, string>) =>
  app.inject({ method: "POST", url: "/auth/login", payload: {}, headers });

describe("rate limiting behind the frontend", () => {
  it("limits each forwarded shopper IP separately", async () => {
    const shopperA = { "x-diau-internal": SECRET, "x-diau-client-ip": "203.0.113.1" };
    for (let i = 0; i < 10; i++) expect((await login(shopperA)).statusCode).toBe(400);
    expect((await login(shopperA)).statusCode).toBe(429);
    // Another shopper coming through the same Next.js server is unaffected.
    expect((await login({ "x-diau-internal": SECRET, "x-diau-client-ip": "203.0.113.2" })).statusCode).toBe(400);
  });

  it("ignores a forwarded IP without the internal secret", async () => {
    const forged = (ip: string) => ({ "x-diau-internal": "wrong", "x-diau-client-ip": ip });
    for (let i = 0; i < 10; i++) await login(forged(`198.51.100.${i}`));
    // All ten shared the socket IP bucket, so rotating the header didn't help.
    expect((await login(forged("198.51.100.99"))).statusCode).toBe(429);
  });
});
