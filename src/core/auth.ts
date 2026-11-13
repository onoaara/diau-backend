import { z } from "zod";

export const ROLES = ["CUSTOMER", "SELLER", "ADMIN", "SUPER_ADMIN"] as const;
export type Role = (typeof ROLES)[number];

/** Admin permission keys. Format: "<area>:<read|write>". */
export const PERMISSIONS = [
  "dashboard:read",
  "products:read",
  "products:write",
  "categories:write",
  "attributes:write",
  "storefront:write", // homepage builder, banners, navigation, pages
  "media:write",
  "theme:write",
  "settings:write",
  "orders:read",
  "orders:write",
  "refunds:write",
  "customers:read",
  "customers:write",
  "promotions:write",
  "reviews:write",
  "users:write", // admin accounts & roles
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ADMIN_DEFAULTS: readonly Permission[] = PERMISSIONS.filter((p) => p !== "users:write");

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  CUSTOMER: [],
  SELLER: ["products:read"],
  ADMIN: ADMIN_DEFAULTS,
  SUPER_ADMIN: PERMISSIONS,
};

export function isAdminRole(role: Role): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

/**
 * SUPER_ADMIN always has everything. For other roles, a non-empty custom
 * permission list replaces the role defaults.
 */
export function effectivePermissions(role: Role, custom: readonly string[] = []): readonly Permission[] {
  if (role === "SUPER_ADMIN") return PERMISSIONS;
  if (custom.length > 0) return PERMISSIONS.filter((p) => custom.includes(p));
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(user: { role: Role; permissions?: readonly string[] }, permission: Permission): boolean {
  return effectivePermissions(user.role, user.permissions).includes(permission);
}

const password = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(128, "Use at most 128 characters");

export const loginSchema = z.object({
  email: z.email("Enter a valid email address").trim().toLowerCase(),
  password: z.string().min(1, "Enter your password").max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Phone numbers: optional, digits with an optional leading + and spaces, dashes or brackets. */
export const phoneSchema = z
  .string()
  .trim()
  .max(24)
  .regex(/^\+?[0-9][0-9 ()-]{5,22}[0-9]$/, "Enter a valid phone number, e.g. +234 801 234 5678")
  .optional()
  .or(z.literal(""));

export const registerSchema = z.object({
  firstName: z.string().trim().min(1, "Enter your first name").max(40),
  lastName: z.string().trim().min(1, "Enter your last name").max(40),
  email: z.email("Enter a valid email address").trim().toLowerCase(),
  phone: phoneSchema,
  password,
  acceptTerms: z.literal(true, { error: "Agree to the Terms and Privacy Policy to continue" }),
  newsletter: z.boolean().default(false),
});

/** Google / Apple sign-in, sent by the web server (internal secret) after the provider vouches for the person. */
export const oauthSignInSchema = z.object({
  provider: z.enum(["google", "apple"]),
  providerAccountId: z.string().min(1).max(255),
  email: z.email().trim().toLowerCase(),
  /** The provider confirmed they own this email (needed to link to an existing account). */
  emailVerified: z.boolean(),
  name: z.string().trim().max(80).nullable().optional(),
  image: z.url().max(1000).nullable().optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

/** User shape returned by the API and stored in the frontend session. */
export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  role: z.enum(ROLES),
  permissions: z.array(z.string()),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const authResponseSchema = z.object({
  user: sessionUserSchema,
  accessToken: z.string(),
  /** Unix seconds. */
  expiresAt: z.number(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;
