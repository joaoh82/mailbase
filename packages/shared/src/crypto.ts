import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bytesToBase64Url } from "./base64";

// Small token/signature helpers shared by the API Worker and scripts.
// Session tokens are random secrets stored only as SHA-256 hashes in D1;
// attachment URLs are signed with HMAC-SHA256 under the SIGNING_KEY secret.

/** URL-safe random token (base64url, no padding). */
export function generateToken(bytes = 32): string {
  return bytesToBase64Url(randomBytes(bytes));
}

export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

export function hmacSha256Hex(key: string, message: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(key), utf8ToBytes(message)));
}

/** Constant-time string comparison (length difference still returns false). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = utf8ToBytes(a);
  const bb = utf8ToBytes(b);
  let diff = ab.length === bb.length ? 0 : 1;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}
