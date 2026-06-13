import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  hmacSha256Base64,
  verifySvixSignature,
} from "../src/index";

const SECRET = "whsec_dGVzdHNlY3JldA"; // whsec_ + base64("testsecret")

// The wire format Svix/Resend send is standard base64 *with* `=` padding.
// Adding padding to our padless encoder's output yields the byte-identical
// string, so this asserts the verifier accepts the real padded form (the bug
// the original code shipped: it only ever compared the padless form).
function sign(id: string, timestamp: string, body: string): string {
  const key = base64ToBytes(SECRET.replace(/^whsec_/, ""));
  const padless = hmacSha256Base64(key, `${id}.${timestamp}.${body}`);
  const padded = padless + "=".repeat((4 - (padless.length % 4)) % 4);
  expect(padded.endsWith("=")).toBe(true); // a 32-byte digest always pads
  return `v1,${padded}`;
}

describe("verifySvixSignature", () => {
  const body = '{"type":"email.bounced"}';
  const now = 1_700_000_000;
  const ts = String(now);

  it("accepts a correctly signed payload", () => {
    expect(
      verifySvixSignature(
        SECRET,
        { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) },
        body,
        300,
        now,
      ),
    ).toBe(true);
  });

  it("also accepts a padless signature (our own encoder's form)", () => {
    const key = base64ToBytes(SECRET.replace(/^whsec_/, ""));
    const padless = hmacSha256Base64(key, `msg_1.${ts}.${body}`);
    expect(padless.endsWith("=")).toBe(false);
    expect(
      verifySvixSignature(
        SECRET,
        { id: "msg_1", timestamp: ts, signature: `v1,${padless}` },
        body,
        300,
        now,
      ),
    ).toBe(true);
  });

  it("accepts when multiple signatures are present (rotation)", () => {
    const good = sign("msg_1", ts, body);
    expect(
      verifySvixSignature(
        SECRET,
        { id: "msg_1", timestamp: ts, signature: `v1,deadbeef ${good}` },
        body,
        300,
        now,
      ),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifySvixSignature(
        SECRET,
        { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) },
        `${body} `,
        300,
        now,
      ),
    ).toBe(false);
  });

  it("rejects a stale timestamp outside tolerance", () => {
    expect(
      verifySvixSignature(
        SECRET,
        { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) },
        body,
        300,
        now + 10_000,
      ),
    ).toBe(false);
  });

  it("rejects missing headers and an empty secret", () => {
    expect(
      verifySvixSignature(SECRET, { id: "", timestamp: ts, signature: "x" }, body),
    ).toBe(false);
    expect(
      verifySvixSignature(
        "",
        { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) },
        body,
        300,
        now,
      ),
    ).toBe(false);
  });
});
