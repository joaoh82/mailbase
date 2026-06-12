import {
  generateToken,
  sessions,
  sha256Hex,
  users,
  verifyPassword,
} from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { User } from "../lib/context";
import type { AppEnv } from "../lib/context";
import {
  clearSessionCookie,
  csrfProtection,
  requireAuth,
  SESSION_TTL_SECONDS,
  setSessionCookie,
} from "../lib/auth";
import {
  clearLoginAttempts,
  loginRateLimitKey,
  registerLoginAttempt,
} from "../lib/rate-limit";

// Hash of "not-a-real-password": verified when the login email is unknown so
// response timing does not reveal which accounts exist.
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$fo0OTgS4B+H+Ofhe5QYN5+XSgWl0tZkycY0wfTvqaV4";

function publicUser(user: User) {
  return {
    id: user.id,
    email: user.emailLogin,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
  };
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) {
    return c.json({ error: "email and password are required" }, 400);
  }

  const db = drizzle(c.env.DB);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const rateKey = loginRateLimitKey(ip, email);
  if (!(await registerLoginAttempt(db, rateKey))) {
    return c.json({ error: "Too many login attempts; try again later" }, 429);
  }

  const user = await db
    .select()
    .from(users)
    .where(eq(users.emailLogin, email))
    .get();
  const valid = user
    ? verifyPassword(password, user.passwordHash)
    : verifyPassword(password, DUMMY_HASH) && false;
  if (!user || !valid) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const token = generateToken();
  const csrfToken = generateToken();
  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash: sha256Hex(token),
    csrfToken,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  });
  await clearLoginAttempts(db, rateKey);

  setSessionCookie(c, token);
  return c.json({ user: publicUser(user), csrfToken });
});

authRoutes.post("/logout", requireAuth, csrfProtection, async (c) => {
  const db = drizzle(c.env.DB);
  await db.delete(sessions).where(eq(sessions.id, c.get("session").id));
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, (c) => {
  return c.json({
    user: publicUser(c.get("user")),
    csrfToken: c.get("session").csrfToken,
  });
});
