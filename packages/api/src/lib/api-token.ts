import { apiTokens, generateToken, sha256Hex, users } from "@mailbase/shared";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createMiddleware } from "hono/factory";
import type { AgentEnv, ApiToken } from "./context";
import { registerWindowHit } from "./rate-limit";

// Personal API tokens (Phase 8, DESIGN.md §6). Format `mb_<base64url 32 bytes>`
// — the prefix makes leaked tokens easy for secret scanners to spot. Only the
// SHA-256 is stored (looked up by hash, like sessions); TOKEN_PREFIX_LENGTH
// characters stay in clear for the settings list. Never log a token, the
// Authorization header, or request bodies: logs carry apiTokenId only.

export const TOKEN_PREFIX = "mb_";
const TOKEN_PREFIX_LENGTH = TOKEN_PREFIX.length + 8;
const LAST_USED_THROTTLE_SECONDS = 60;
const REQUEST_WINDOW_SECONDS = 60;

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
// Matches Resend's free tier (100 emails/day).
export const DEFAULT_DAILY_SEND_CAP = 100;
export const MAX_RATE_LIMIT_PER_MINUTE = 6000;
export const MAX_DAILY_SEND_CAP = 10000;

export function mintApiToken(): { token: string; hash: string; prefix: string } {
  const token = `${TOKEN_PREFIX}${generateToken()}`;
  return {
    token,
    hash: sha256Hex(token),
    prefix: token.slice(0, TOKEN_PREFIX_LENGTH),
  };
}

export function tokenStatus(t: ApiToken, now = Date.now()) {
  if (t.revokedAt) return "revoked" as const;
  if (t.expiresAt && t.expiresAt.getTime() <= now) return "expired" as const;
  return "active" as const;
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const token = match?.[1];
  return token && token.startsWith(TOKEN_PREFIX) ? token : null;
}

/**
 * Resolves `Authorization: Bearer mb_…` to a user + token, or responds 401.
 * Cookies are deliberately ignored: these routes must never be reachable with
 * the session cookie (that would bypass CSRF). Enforces the token's request
 * rate limit (429 + Retry-After) and throttles last_used_at writes.
 */
export const requireApiToken = createMiddleware<AgentEnv>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) {
    return c.json(
      { error: "An API token is required (Authorization: Bearer mb_…)" },
      401,
    );
  }

  const db = drizzle(c.env.DB);
  const row = await db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, sha256Hex(token)))
    .get();
  if (!row || tokenStatus(row.token) !== "active") {
    return c.json({ error: "Invalid, expired or revoked API token" }, 401);
  }

  const hit = await registerWindowHit(
    db,
    `tok:req:${row.token.id}`,
    REQUEST_WINDOW_SECONDS,
    row.token.rateLimitPerMinute,
  );
  if (!hit.allowed) {
    c.header("Retry-After", String(hit.retryAfter));
    return c.json(
      {
        error: `Rate limit of ${row.token.rateLimitPerMinute} requests per minute exceeded`,
        code: "rate_limited",
      },
      429,
    );
  }

  // At most one write a minute: the conditional UPDATE matches no row while
  // last_used_at is fresh.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const stale = new Date((nowSeconds - LAST_USED_THROTTLE_SECONDS) * 1000);
  await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date(nowSeconds * 1000) })
    .where(
      and(
        eq(apiTokens.id, row.token.id),
        or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, stale)),
      ),
    );

  c.set("user", row.user);
  c.set("apiToken", row.token);
  await next();
});
