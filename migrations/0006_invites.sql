-- Migration 0006: Phase 4 multi-account — user invitations.
--
-- An invite lets an existing owner/admin onboard a brand-new login: it names a
-- target mailbox + role, and carries a one-time secret token (stored only as a
-- SHA-256 hash, like sessions). The recipient opens the link, sets a password,
-- and the accept flow creates the user, the mailbox membership, and a send-as
-- identity for each address of that mailbox. Tokens expire and are single-use
-- (accepted_at is stamped on consumption).

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,                                  -- login email (lowercased)
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',                  -- role granted in the mailbox
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,                                  -- NULL until consumed
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_invites_mailbox ON invites(mailbox_id);
