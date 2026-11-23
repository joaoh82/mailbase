-- Migration 0012: personal API tokens for agent access (Phase 8).
--
-- A token is a second credential for a user, used by agents (MCP clients and
-- REST callers) on the bearer-only /api/v1 and /api/mcp routes. It carries no
-- scopes of its own: a token reaches exactly what its user reaches through
-- mailbox_members and identities, minus the session-only surface (admin,
-- mailbox management, token management). Like sessions and invites, the token
-- itself is never stored, only its SHA-256 hash; token_prefix keeps the first
-- characters in clear so the settings UI can tell tokens apart.

CREATE TABLE api_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  -- Per-token limits, editable in the settings UI. Requests are counted per
  -- 60-second window; sends per UTC day (0 = this token may not send).
  rate_limit_per_minute integer NOT NULL DEFAULT 120,
  daily_send_cap integer NOT NULL DEFAULT 100,
  -- NULL = never expires.
  expires_at integer,
  -- Written at most once a minute, so agent calls don't each cost a D1 write.
  last_used_at integer,
  -- Set on revoke; a revoked token is rejected on the very next request.
  revoked_at integer,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_api_tokens_user ON api_tokens (user_id);

-- Generic fixed-window counters (per-token request limit and daily send cap).
-- One row per key, upserted atomically; window_start is the window's aligned
-- start in epoch seconds. login_attempts keeps its own table (migration 0004).
CREATE TABLE rate_limit_counters (
  key text PRIMARY KEY,
  window_start integer NOT NULL,
  count integer NOT NULL DEFAULT 0
);
