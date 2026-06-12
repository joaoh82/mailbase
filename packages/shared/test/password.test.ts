import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../src/base64";
import { hashPassword, verifyPassword } from "../src/password";

// Weak params keep these fast; verifyPassword reads params from the PHC
// string, so they exercise the same code paths as production hashes.
const FAST = { m: 64, t: 1, p: 1 };

describe("password hashing", () => {
  it("round-trips a correct password", () => {
    const phc = hashPassword("hunter2", FAST);
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=64,t=1,p=1\$/);
    expect(verifyPassword("hunter2", phc)).toBe(true);
  });

  it("rejects a wrong password and salts uniquely", () => {
    const phc = hashPassword("hunter2", FAST);
    expect(verifyPassword("hunter3", phc)).toBe(false);
    expect(hashPassword("hunter2", FAST)).not.toBe(phc);
  });

  it("rejects malformed stored hashes instead of throwing", () => {
    expect(verifyPassword("hunter2", "")).toBe(false);
    expect(verifyPassword("hunter2", "$2b$10$bcrypt-style")).toBe(false);
  });
});

describe("base64", () => {
  it("round-trips arbitrary bytes, unpadded", () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 33]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) % 256);
      const encoded = bytesToBase64(bytes);
      expect(encoded).not.toContain("=");
      expect(base64ToBytes(encoded)).toEqual(bytes);
    }
  });
});
