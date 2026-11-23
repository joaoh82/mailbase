import { SELF } from "cloudflare:test";
import { apiTokens, sha256Hex, users } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentFetch,
  createApiToken,
  db,
  login,
  seed,
  type LoginResult,
} from "./seed";

let auth: LoginResult;

beforeEach(async () => {
  await seed();
  auth = await login();
});

function session(path: string, init: { method?: string; body?: unknown } = {}) {
  return SELF.fetch(`http://webmail.local${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrfToken,
      "Content-Type": "application/json",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

describe("token management (session routes)", () => {
  it("creates a token, returns it once, and stores only its hash", async () => {
    const res = await session("/api/tokens", {
      body: { name: "grokbot", expiresInDays: 30 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: string;
      apiToken: { id: string; prefix: string; status: string; dailySendCap: number; rateLimitPerMinute: number; expiresAt: string };
    };
    expect(body.token).toMatch(/^mb_[A-Za-z0-9_-]{43}$/);
    expect(body.token.startsWith(body.apiToken.prefix)).toBe(true);
    expect(body.apiToken.status).toBe("active");
    expect(body.apiToken.rateLimitPerMinute).toBe(120);
    expect(body.apiToken.dailySendCap).toBe(100);
    expect(body.apiToken.expiresAt).not.toBeNull();

    const row = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, body.apiToken.id))
      .get();
    expect(row?.tokenHash).toBe(sha256Hex(body.token));
    expect(row?.tokenHash).not.toContain(body.token);

    const list = await session("/api/tokens");
    const listed = (await list.json()) as { tokens: Record<string, unknown>[] };
    expect(listed.tokens).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(body.token);
    expect(listed.tokens[0]).not.toHaveProperty("tokenHash");

    // The new token works.
    const me = await agentFetch("/api/v1/me", body.token);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe("user-josh");
  });

  it("validates name and limits", async () => {
    expect((await session("/api/tokens", { body: {} })).status).toBe(400);
    expect(
      (await session("/api/tokens", { body: { name: "x", dailySendCap: -1 } })).status,
    ).toBe(400);
    expect(
      (await session("/api/tokens", { body: { name: "x", rateLimitPerMinute: 0 } }))
        .status,
    ).toBe(400);
  });

  it("edits limits and revokes, effective on the next request", async () => {
    const { token, id } = await createApiToken();
    const patch = await session(`/api/tokens/${id}`, {
      method: "PATCH",
      body: { dailySendCap: 5, rateLimitPerMinute: 30 },
    });
    expect(patch.status).toBe(200);
    expect(
      ((await patch.json()) as { apiToken: { dailySendCap: number } }).apiToken.dailySendCap,
    ).toBe(5);

    expect((await agentFetch("/api/v1/me", token)).status).toBe(200);
    const del = await session(`/api/tokens/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { apiToken: { status: string } }).apiToken.status).toBe(
      "revoked",
    );
    expect((await agentFetch("/api/v1/me", token)).status).toBe(401);
  });

  it("can't touch another user's tokens", async () => {
    const { id } = await createApiToken("user-other");
    expect((await session(`/api/tokens/${id}`, { method: "DELETE" })).status).toBe(404);
    expect(
      (await session(`/api/tokens/${id}`, { method: "PATCH", body: { name: "x" } })).status,
    ).toBe(404);
    const list = (await (await session("/api/tokens")).json()) as { tokens: unknown[] };
    expect(list.tokens).toHaveLength(0);
  });

  it("requires CSRF to create a token", async () => {
    const res = await SELF.fetch("http://webmail.local/api/tokens", {
      method: "POST",
      headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("bearer authentication", () => {
  it("rejects missing, malformed and unknown tokens", async () => {
    expect((await SELF.fetch("http://webmail.local/api/v1/me")).status).toBe(401);
    expect((await agentFetch("/api/v1/me", "not-a-token")).status).toBe(401);
    expect((await agentFetch("/api/v1/me", "mb_unknown")).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const { token } = await createApiToken("user-josh", {
      expiresAt: new Date(Date.now() - 1000),
    });
    expect((await agentFetch("/api/v1/me", token)).status).toBe(401);
  });

  it("rejects a deleted user's token", async () => {
    const { token } = await createApiToken("user-other");
    await db.delete(users).where(eq(users.id, "user-other"));
    expect((await agentFetch("/api/v1/me", token)).status).toBe(401);
  });

  it("updates last_used_at at most once a minute", async () => {
    const { token, id } = await createApiToken();
    await agentFetch("/api/v1/me", token);
    const first = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    expect(first?.lastUsedAt).toBeInstanceOf(Date);
    // Pretend it was used 30 s ago: a new request must not rewrite it.
    const recent = new Date(Math.floor(Date.now() / 1000 - 30) * 1000);
    await db.update(apiTokens).set({ lastUsedAt: recent }).where(eq(apiTokens.id, id));
    await agentFetch("/api/v1/me", token);
    const second = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    expect(second?.lastUsedAt?.getTime()).toBe(recent.getTime());
    // Two minutes old: it is refreshed.
    const old = new Date(Math.floor(Date.now() / 1000 - 120) * 1000);
    await db.update(apiTokens).set({ lastUsedAt: old }).where(eq(apiTokens.id, id));
    await agentFetch("/api/v1/me", token);
    const third = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    expect(third!.lastUsedAt!.getTime()).toBeGreaterThan(old.getTime());
  });
});

describe("the auth line", () => {
  it("never lets a token reach admin routes, even an admin's", async () => {
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, "user-josh"));
    const { token } = await createApiToken();
    expect((await agentFetch("/api/admin/domains", token)).status).toBe(401);
    expect((await agentFetch("/api/v1/admin/domains", token)).status).toBe(404);
  });

  it("never lets a token reach session routes", async () => {
    const { token } = await createApiToken();
    for (const path of [
      "/api/messages/msg-1",
      "/api/tokens",
      "/api/mailboxes",
      "/api/mailboxes/mbx-josh/members",
      "/api/drafts",
      "/api/auth/me",
    ]) {
      expect((await agentFetch(path, token)).status, path).toBe(401);
    }
    const mint = await agentFetch("/api/tokens", token, { body: { name: "x" } });
    expect(mint.status).toBe(401);
  });

  it("ignores the session cookie on agent routes", async () => {
    for (const path of ["/api/v1/me", "/api/v1/mailboxes", "/api/mcp"]) {
      const res = await SELF.fetch(`http://webmail.local${path}`, {
        method: path === "/api/mcp" ? "POST" : "GET",
        headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrfToken },
      });
      expect(res.status, path).toBe(401);
    }
  });

  it("404s unknown agent paths instead of falling through", async () => {
    const { token } = await createApiToken();
    expect((await agentFetch("/api/v1/nope", token)).status).toBe(404);
    expect((await agentFetch("/api/v1/mailboxes/mbx-josh/members", token)).status).toBe(404);
    expect((await agentFetch("/api/mcp/extra", token)).status).toBe(404);
  });
});

describe("per-token request rate limit", () => {
  it("returns 429 with Retry-After past the limit", async () => {
    const { token } = await createApiToken("user-josh", { rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await agentFetch("/api/v1/me", token)).status).toBe(200);
    }
    const limited = await agentFetch("/api/v1/me", token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await limited.json()) as { code: string }).code).toBe("rate_limited");
    // MCP shares the same limit.
    expect(
      (await agentFetch("/api/mcp", token, { body: { jsonrpc: "2.0", id: 1, method: "ping" } }))
        .status,
    ).toBe(429);
  });

  it("resets when the window rolls over", async () => {
    const { token, id } = await createApiToken("user-josh", { rateLimitPerMinute: 1 });
    expect((await agentFetch("/api/v1/me", token)).status).toBe(200);
    expect((await agentFetch("/api/v1/me", token)).status).toBe(429);
    // Age the counter's window into the past.
    await env_rewindCounter(`tok:req:${id}`);
    expect((await agentFetch("/api/v1/me", token)).status).toBe(200);
  });
});

async function env_rewindCounter(key: string) {
  const { rateLimitCounters } = await import("@mailbase/shared");
  await db
    .update(rateLimitCounters)
    .set({ windowStart: 0 })
    .where(eq(rateLimitCounters.key, key));
}
