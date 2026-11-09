import { jwtVerify, SignJWT } from "jose";
import { ROLES, type Role } from "../core";
import { env } from "../env";

const secret = new TextEncoder().encode(env.API_JWT_SECRET);
const ISSUER = "diau-api";
const AUDIENCE = "diau-web";

export type AccessTokenClaims = { sub: string; role: Role; perms: string[] };

export async function signAccessToken(claims: AccessTokenClaims): Promise<{ token: string; expiresAt: number }> {
  const token = await new SignJWT({ role: claims.role, perms: claims.perms })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.API_JWT_TTL)
    .sign(secret);
  const { payload } = await jwtVerify(token, secret);
  return { token, expiresAt: payload.exp ?? 0 };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    const role = payload.role;
    if (typeof payload.sub !== "string" || typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
      return null;
    }
    const perms = Array.isArray(payload.perms) ? payload.perms.filter((p): p is string => typeof p === "string") : [];
    return { sub: payload.sub, role: role as Role, perms };
  } catch {
    return null;
  }
}
