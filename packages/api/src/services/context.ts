import type { DrizzleD1Database } from "drizzle-orm/d1";

// The service layer (Phase 8) is plain functions over { db, env, userId }, with
// no Hono context, so the cookie-session routes, the bearer-only /api/v1 REST
// routes and the /api/mcp tools all run the same code. Every service authorizes
// through lib/access.ts (mailbox membership) and identities.userId with the
// caller's userId; a token is just "a userId reached by another credential".
export interface ServiceContext {
  db: DrizzleD1Database;
  env: Env;
  userId: string;
}

/** A per-token daily send cap, enforced inside sendMessage (agents only). */
export interface SendQuota {
  tokenId: string;
  dailySendCap: number;
}

/**
 * An expected failure (not found, forbidden, validation, limits). Routes turn it
 * into `{ error, code? }` with `status`; MCP tools into an `isError` result.
 * Messages are short and never carry bodies, tokens or stack traces.
 */
export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 500 | 502,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
