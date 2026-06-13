import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64ToBytes, bytesToBase64, bytesToBase64Url } from "./base64";

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

/** HMAC-SHA256 with a raw key, returned as standard (padless) base64. */
export function hmacSha256Base64(key: Uint8Array, message: string): string {
  return bytesToBase64(hmac(sha256, key, utf8ToBytes(message)));
}

export interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

// Resend signs webhooks with the Svix scheme (the same one Resend's own SDK
// verifies): HMAC-SHA256 over "<id>.<timestamp>.<body>" with the secret, which
// is the part of `whsec_…` after the prefix, base64-decoded. The signature
// header is a space-separated list of "v1,<base64sig>" entries (a secret may be
// rotated, so several can be present); any match is valid. We implement it here
// rather than pull in the Svix/Resend SDK so it runs on Workers with no deps.
export function verifySvixSignature(
  secret: string,
  headers: SvixHeaders,
  body: string,
  toleranceSeconds = 5 * 60,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) {
    return false;
  }
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const key = base64ToBytes(secret.replace(/^whsec_/, ""));
  // Svix/Resend send standard *padded* base64; our hmac helper is padless.
  // Compare with padding stripped from both sides so either form verifies.
  const expected = hmacSha256Base64(
    key,
    `${headers.id}.${headers.timestamp}.${body}`,
  ).replace(/=+$/, "");
  for (const part of headers.signature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    const version = part.slice(0, comma);
    const sig = part.slice(comma + 1).replace(/=+$/, "");
    if (version === "v1" && constantTimeEqual(sig, expected)) return true;
  }
  return false;
}
