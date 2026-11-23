import { apiTokens } from "@mailbase/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import {
  DEFAULT_DAILY_SEND_CAP,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  MAX_DAILY_SEND_CAP,
  MAX_RATE_LIMIT_PER_MINUTE,
  mintApiToken,
} from "../lib/api-token";
import type { AppEnv } from "../lib/context";
import { serializeApiToken } from "../lib/serialize";

// Personal API token management (Phase 8). Session + CSRF only — mounted after
// the session line — so a token can never mint, list or revoke tokens. Every
// query is scoped to the signed-in user; another user's token is a 404.

export const tokenRoutes = new Hono<AppEnv>();

const MAX_NAME_LENGTH = 64;
const MAX_EXPIRY_DAYS = 3650;

type Limits = { rateLimitPerMinute?: number; dailySendCap?: number };

function parseLimits(body: Record<string, unknown>): Limits | string {
  const out: Limits = {};
  if (body.rateLimitPerMinute !== undefined) {
    const v = body.rateLimitPerMinute;
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < 1 ||
      v > MAX_RATE_LIMIT_PER_MINUTE
    ) {
      return `rateLimitPerMinute must be an integer 1–${MAX_RATE_LIMIT_PER_MINUTE}`;
    }
    out.rateLimitPerMinute = v;
  }
  if (body.dailySendCap !== undefined) {
    const v = body.dailySendCap;
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < 0 ||
      v > MAX_DAILY_SEND_CAP
    ) {
      return `dailySendCap must be an integer 0–${MAX_DAILY_SEND_CAP}`;
    }
    out.dailySendCap = v;
  }
  return out;
}

function parseName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

// The caller's tokens, newest first, revoked/expired included (with status).
// The token itself is never returned after creation.
tokenRoutes.get("/", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, c.get("user").id))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
    .all();
  return c.json({ tokens: rows.map((t) => serializeApiToken(t)) });
});

// Create a token. The response carries the token ONCE; only its hash is kept.
tokenRoutes.post("/", async (c) => {
  const db = drizzle(c.env.DB);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
  const name = parseName(body.name);
  if (!name) {
    return c.json(
      { error: `name is required (1–${MAX_NAME_LENGTH} characters)` },
      400,
    );
  }
  const limits = parseLimits(body);
  if (typeof limits === "string") return c.json({ error: limits }, 400);

  let expiresAt: Date | null = null;
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const days = body.expiresInDays;
    if (
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > MAX_EXPIRY_DAYS
    ) {
      return c.json(
        { error: `expiresInDays must be an integer 1–${MAX_EXPIRY_DAYS}` },
        400,
      );
    }
    expiresAt = new Date(
      (Math.floor(Date.now() / 1000) + days * 86400) * 1000,
    );
  }

  const minted = mintApiToken();
  const row = await db
    .insert(apiTokens)
    .values({
      id: crypto.randomUUID(),
      userId: c.get("user").id,
      name,
      tokenHash: minted.hash,
      tokenPrefix: minted.prefix,
      rateLimitPerMinute:
        limits.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      dailySendCap: limits.dailySendCap ?? DEFAULT_DAILY_SEND_CAP,
      expiresAt,
    })
    .returning()
    .get();
  return c.json({ token: minted.token, apiToken: serializeApiToken(row) }, 201);
});

// Rename or change a token's limits. Revoked tokens can't be edited.
tokenRoutes.patch("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
  const update: Limits & { name?: string } = {};
  if (body.name !== undefined) {
    const name = parseName(body.name);
    if (!name) {
      return c.json({ error: `name must be 1–${MAX_NAME_LENGTH} characters` }, 400);
    }
    update.name = name;
  }
  const limits = parseLimits(body);
  if (typeof limits === "string") return c.json({ error: limits }, 400);
  Object.assign(update, limits);
  if (Object.keys(update).length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  const row = await db
    .update(apiTokens)
    .set(update)
    .where(
      and(
        eq(apiTokens.id, c.req.param("id")),
        eq(apiTokens.userId, c.get("user").id),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning()
    .get();
  if (!row) return c.json({ error: "Token not found" }, 404);
  return c.json({ apiToken: serializeApiToken(row) });
});

// Revoke a token. Takes effect on the very next request it makes. Idempotent.
tokenRoutes.delete("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const where = and(
    eq(apiTokens.id, c.req.param("id")),
    eq(apiTokens.userId, c.get("user").id),
  );
  const existing = await db.select().from(apiTokens).where(where).get();
  if (!existing) return c.json({ error: "Token not found" }, 404);
  const row = existing.revokedAt
    ? existing
    : await db
        .update(apiTokens)
        .set({ revokedAt: new Date(Math.floor(Date.now() / 1000) * 1000) })
        .where(where)
        .returning()
        .get();
  return c.json({ apiToken: serializeApiToken(row ?? existing) });
});
