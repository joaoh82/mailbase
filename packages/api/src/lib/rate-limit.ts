import { loginAttempts } from "@mailbase/shared";
import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

// Fixed-window counter in D1 (DESIGN.md §6 allows a KV counter; D1 keeps us
// to the bindings we already have). Counts every attempt — including
// successes, which then reset the window via clearLoginAttempts.

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
