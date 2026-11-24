import { loginAttempts, rateLimitCounters } from "@mailbase/shared";
import { and, eq, gt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

// Fixed-window counters in D1 (DESIGN.md §6 allows a KV counter; D1 keeps us
// to the bindings we already have).
//
// Login: counts every attempt — including successes, which then reset the
// window via clearLoginAttempts — in a window that starts at the first attempt.
//
// Generic (Phase 8, per-token request limit and daily send cap): windows are
// aligned to multiples of windowSeconds since the epoch, so a 86400 s window
// is exactly one UTC day.

export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_MAX_ATTEMPTS = 10;

/** Records one attempt; returns false when the key is over the limit. */
export async function registerLoginAttempt(
  db: DrizzleD1Database,
  key: string,
): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowFloor = nowSeconds - LOGIN_WINDOW_SECONDS;
  // CASE expressions read the pre-update row, so an expired window resets
  // atomically even when attempts race.
  const row = await db
    .insert(loginAttempts)
    .values({ key, windowStart: new Date(nowSeconds * 1000), count: 1 })
    .onConflictDoUpdate({
      target: loginAttempts.key,
      set: {
        count: sql`CASE WHEN ${loginAttempts.windowStart} <= ${windowFloor} THEN 1 ELSE ${loginAttempts.count} + 1 END`,
        windowStart: sql`CASE WHEN ${loginAttempts.windowStart} <= ${windowFloor} THEN ${nowSeconds} ELSE ${loginAttempts.windowStart} END`,
      },
    })
    .returning({ count: loginAttempts.count })
    .get();
  return row.count <= LOGIN_MAX_ATTEMPTS;
}

export async function clearLoginAttempts(
  db: DrizzleD1Database,
  key: string,
): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.key, key));
}

export function loginRateLimitKey(ip: string, email: string): string {
  return `${ip}:${email}`;
}

export interface WindowHit {
  allowed: boolean;
  count: number;
  /** Seconds until the current window ends (for Retry-After). */
  retryAfter: number;
}

function currentWindow(windowSeconds: number) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (now % windowSeconds);
  return { now, start };
}

/**
 * Counts one hit against `key` in the current aligned window and reports
 * whether it is within `max`. One atomic upsert: the CASE reads the pre-update
 * row, so a stale window resets to 1 even when hits race. A hit is counted
 * even when it is refused (harmless: the window still ends on time).
 */
export async function registerWindowHit(
  db: DrizzleD1Database,
  key: string,
  windowSeconds: number,
  max: number,
): Promise<WindowHit> {
  const { now, start } = currentWindow(windowSeconds);
  const row = await db
    .insert(rateLimitCounters)
    .values({ key, windowStart: start, count: 1 })
    .onConflictDoUpdate({
      target: rateLimitCounters.key,
      set: {
        count: sql`CASE WHEN ${rateLimitCounters.windowStart} < ${start} THEN 1 ELSE ${rateLimitCounters.count} + 1 END`,
        windowStart: sql`CASE WHEN ${rateLimitCounters.windowStart} < ${start} THEN ${start} ELSE ${rateLimitCounters.windowStart} END`,
      },
    })
    .returning({ count: rateLimitCounters.count })
    .get();
  return {
    allowed: row.count <= max,
    count: row.count,
    retryAfter: Math.max(1, start + windowSeconds - now),
  };
}

/**
 * Gives back one hit in the current window (e.g. a send the provider refused).
 * A no-op once the window has rolled over or the count is already 0.
 */
export async function refundWindowHit(
  db: DrizzleD1Database,
  key: string,
  windowSeconds: number,
): Promise<void> {
  const { start } = currentWindow(windowSeconds);
  await db
    .update(rateLimitCounters)
    .set({ count: sql`${rateLimitCounters.count} - 1` })
    .where(
      and(
        eq(rateLimitCounters.key, key),
        eq(rateLimitCounters.windowStart, start),
        gt(rateLimitCounters.count, 0),
      ),
    );
}
