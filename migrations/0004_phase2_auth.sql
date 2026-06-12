-- Migration 0004: Phase 2 auth — CSRF token per session, login rate limiting.

-- Each session carries a CSRF token, returned to the SPA at login / via
-- /api/auth/me and required in the X-CSRF-Token header on every mutation.
-- No sessions exist before Phase 2 ships, so the backfill default is moot.
ALTER TABLE sessions ADD COLUMN csrf_token TEXT NOT NULL DEFAULT '';

-- Fixed-window login rate limiting, keyed by client IP + login email.
CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
