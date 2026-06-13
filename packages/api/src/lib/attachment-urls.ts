import { hmacSha256Hex } from "@mailbase/shared";
import { HTTPException } from "hono/http-exception";

// Attachment downloads use signed, expiring URLs (DESIGN.md §6) so the
// sandboxed UI and plain browser downloads work without sending the session
// cookie anywhere unusual. The signature, not a session, is the authorization.

export const ATTACHMENT_URL_TTL_SECONDS = 15 * 60;

export function attachmentSignature(
  signingKey: string,
  attachmentId: string,
  expiresAt: number,
): string {
  return hmacSha256Hex(signingKey, `attachment:${attachmentId}:${expiresAt}`);
}

export function requireSigningKey(env: Env): string {
  if (!env.SIGNING_KEY) {
    throw new HTTPException(500, {
      message:
        "SIGNING_KEY secret is not configured (wrangler secret put SIGNING_KEY, or .dev.vars locally)",
    });
  }
  return env.SIGNING_KEY;
}
