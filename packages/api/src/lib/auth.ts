import { constantTimeEqual, sessions, sha256Hex, users } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";

export const SESSION_COOKIE = "session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Resolves the session cookie to a user + session, or responds 401. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "Not signed in" }, 401);

  const db = drizzle(c.env.DB);
  const row = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, sha256Hex(token)))
    .get();
  if (!row) {
    clearSessionCookie(c);
    return c.json({ error: "Not signed in" }, 401);
  }
  if (row.session.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, row.session.id));
    clearSessionCookie(c);
    return c.json({ error: "Session expired" }, 401);
  }

  c.set("user", row.user);
  c.set("session", row.session);
  await next();
});

/**
 * Rejects state-changing requests whose X-CSRF-Token header does not match
 * the session's token. Must run after requireAuth.
 */
export const csrfProtection = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const session = c.get("session");
    const header = c.req.header("X-CSRF-Token") ?? "";
    if (!session.csrfToken || !constantTimeEqual(header, session.csrfToken)) {
      return c.json({ error: "CSRF token missing or invalid" }, 403);
    }
  }
  await next();
});
