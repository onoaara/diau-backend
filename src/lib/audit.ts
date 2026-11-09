import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";
import { stableStringify } from "./stable-json";

type AuditInput = {
  actorId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  summary: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
};

/** Keeps only fields that changed, so diffs stay small and readable. */
export function diffObjects(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined) {
  if (!before || !after) return { before: before ?? null, after: after ?? null };
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (stableStringify(before[key]) !== stableStringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}

export async function audit(input: AuditInput): Promise<void> {
  const diff = input.before || input.after ? diffObjects(input.before, input.after) : null;
  await prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      summary: input.summary,
      diff: (diff ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: input.ip ?? null,
    },
  });
}
