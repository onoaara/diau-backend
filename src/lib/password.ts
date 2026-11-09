import bcrypt from "bcryptjs";

const ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a real bcrypt comparison against a throwaway hash so a login for an
 * unknown email takes as long as one for a known email (no user enumeration by timing).
 */
export async function burnPasswordCheck(plain: string): Promise<false> {
  dummyHash ??= bcrypt.hash("diau-timing-equalizer", ROUNDS);
  await bcrypt.compare(plain, await dummyHash);
  return false;
}
