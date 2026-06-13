import { argon2id } from "@noble/hashes/argon2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64ToBytes, bytesToBase64 } from "./base64";

// Argon2id password hashing in PHC string format
// ($argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>, unpadded base64).
// Pure-JS (@noble/hashes) so the exact same code runs in the API Worker,
// the Workers test pool, and the Node seed script.

export interface Argon2Params {
  /** Memory cost in KiB. */
  m: number;
  /** Iterations. */
  t: number;
  /** Parallelism. */
  p: number;
}

// OWASP recommended minimums for argon2id: 19 MiB, 2 iterations, 1 lane.
export const ARGON2_DEFAULT_PARAMS: Argon2Params = { m: 19456, t: 2, p: 1 };

const SALT_LENGTH = 16;
const HASH_LENGTH = 32;

export function hashPassword(
  password: string,
  params: Argon2Params = ARGON2_DEFAULT_PARAMS,
): string {
  const salt = randomBytes(SALT_LENGTH);
  const hash = argon2id(password, salt, { ...params, dkLen: HASH_LENGTH });
  return `$argon2id$v=19$m=${params.m},t=${params.t},p=${params.p}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** Verify a password against a PHC string produced by hashPassword. */
export function verifyPassword(password: string, stored: string): boolean {
  const match = PHC_PATTERN.exec(stored);
  if (!match) return false;
  const [, m, t, p, saltB64, hashB64] = match;
  const expected = base64ToBytes(hashB64!);
  const actual = argon2id(password, base64ToBytes(saltB64!), {
    m: Number(m),
    t: Number(t),
    p: Number(p),
    dkLen: expected.length,
  });
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}
