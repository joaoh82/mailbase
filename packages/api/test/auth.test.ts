import { SELF } from "cloudflare:test";
import { loginAttempts, sessions } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, login, seed, TEST_PASSWORD } from "./seed";

beforeEach(seed);

describe("auth", () => {
  it("rejects a wrong password without setting a cookie", async () => {
    const { res } = await login("josh@login.test", "wrong-password");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an unknown email with the same response shape", async () => {
    const { res } = await login("nobody@login.test");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid email or password" });
  });

  it("logs in with correct credentials and a hardened cookie", async () => {
    const { res, cookie, csrfToken } = await login();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string } };
    expect(body.user.email).toBe("josh@login.test");
    expect(csrfToken).not.toBe("");

    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    // Only a hash of the token is stored.
    const token = cookie.replace("session=", "");
    const row = await db.select().from(sessions).get();
    expect(row).toBeDefined();
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.csrfToken).toBe(csrfToken);
  });

  it("email comparison is case-insensitive", async () => {
    const { res } = await login("JOSH@Login.Test");
    expect(res.status).toBe(200);
  });

  it("GET /api/auth/me requires and resolves the session", async () => {
    const anon = await SELF.fetch("http://webmail.local/api/auth/me");
    expect(anon.status).toBe(401);

    const { cookie, csrfToken } = await login();
    const res = await SELF.fetch("http://webmail.local/api/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { email: string };
      csrfToken: string;
    };
    expect(body.user.email).toBe("josh@login.test");
    expect(body.csrfToken).toBe(csrfToken);
  });

  it("logout requires a CSRF token, then kills the session", async () => {
    const { cookie, csrfToken } = await login();

    const noCsrf = await SELF.fetch("http://webmail.local/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(noCsrf.status).toBe(403);

    const res = await SELF.fetch("http://webmail.local/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": csrfToken },
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(sessions).all()).toHaveLength(0);

    const after = await SELF.fetch("http://webmail.local/api/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(after.status).toBe(401);
  });

  it("rejects expired sessions and deletes them", async () => {
    const { cookie } = await login();
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    const res = await SELF.fetch("http://webmail.local/api/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(401);
    expect(await db.select().from(sessions).all()).toHaveLength(0);
  });

  it("rate-limits repeated login attempts per IP and email", async () => {
    for (let i = 0; i < 10; i++) {
      const { res } = await login("josh@login.test", "wrong-password");
      expect(res.status).toBe(401);
    }
    // Even the correct password is refused once the window is exhausted.
    const { res: blocked } = await login("josh@login.test", TEST_PASSWORD);
    expect(blocked.status).toBe(429);

    // A different account from the same IP is not affected.
    const { res: other } = await login("other@login.test", TEST_PASSWORD);
    expect(other.status).toBe(200);
  });

  it("a successful login clears the attempt counter", async () => {
    await login("josh@login.test", "wrong-password");
    await login("josh@login.test", "wrong-password");
    const { res } = await login();
    expect(res.status).toBe(200);
    expect(await db.select().from(loginAttempts).all()).toHaveLength(0);
  });

  it("rejects malformed login bodies", async () => {
    const res = await SELF.fetch("http://webmail.local/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("requires auth for all mail endpoints", async () => {
    for (const path of [
      "/api/mailboxes",
      "/api/mailboxes/mbx-josh/messages",
      "/api/mailboxes/mbx-josh/search?q=x",
      "/api/messages/msg-1",
      "/api/messages/msg-1/full",
      "/api/messages/msg-1/raw",
      "/api/threads/thr-1",
    ]) {
      const res = await SELF.fetch(`http://webmail.local${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  it("rejects mutations with a wrong CSRF token", async () => {
    const { cookie } = await login();
    const res = await SELF.fetch(
      "http://webmail.local/api/messages/msg-1/read",
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": "forged-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isRead: true }),
      },
    );
    expect(res.status).toBe(403);
  });
});
