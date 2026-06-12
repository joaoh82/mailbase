// Minimal unpadded base64, dependency- and platform-free (no btoa/atob, so
// it typechecks and runs identically in Workers, Node scripts, and tests).

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const REVERSE = new Map<string, number>(
  [...ALPHABET].map((ch, i) => [ch, i] as const),
);

/** Standard base64 without padding (the PHC string flavor). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2]!;
    out += ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 !== undefined) {
      out += ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)]!;
    }
    if (b2 !== undefined) out += ALPHABET[b2 & 0b111111]!;
  }
  return out;
}

/** URL-safe base64 without padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}

/** Inverse of bytesToBase64; throws on characters outside the alphabet. */
export function base64ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    const value = REVERSE.get(ch);
    if (value === undefined) throw new Error(`Invalid base64 character: ${ch}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}
