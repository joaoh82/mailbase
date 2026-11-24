-- Migration 0013: server-side drafts (Phase 8).
--
-- Drafts get their own table rather than a 'drafts' value in messages.folder:
-- that would need a SQLite rebuild of messages (CHECK constraint, FTS triggers,
-- the partial unique index, inbound FKs), and drafts don't belong in FTS,
-- threads or unread counts anyway. A draft is author-private: visible only to
-- user_id, and only while that user is still a member of mailbox_id. Nothing
-- stored here is trusted at send time; identity ownership, mailbox membership
-- and access to the source message are all re-checked then.

CREATE TABLE drafts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  identity_id text REFERENCES identities(id) ON DELETE SET NULL,
  to_addrs text NOT NULL DEFAULT '[]',
  cc_addrs text NOT NULL DEFAULT '[]',
  bcc_addrs text NOT NULL DEFAULT '[]',
  subject text NOT NULL DEFAULT '',
  body_html text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  mode text NOT NULL DEFAULT 'new'
    CHECK (mode IN ('new', 'reply', 'reply_all', 'forward')),
  -- The parent of a reply/forward; NULL for a fresh compose or once purged.
  source_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  -- Optimistic concurrency: every update must name the version it read.
  version integer NOT NULL DEFAULT 1,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_drafts_user_mailbox ON drafts (user_id, mailbox_id, updated_at);

-- Attachments carried by a draft; bytes live in R2 under drafts/{draftId}/.
CREATE TABLE draft_attachments (
  id text PRIMARY KEY,
  draft_id text NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL,
  r2_key text NOT NULL UNIQUE
);

CREATE INDEX idx_draft_attachments_draft ON draft_attachments (draft_id);

-- check_new_mail polls by ingest order (created_at, id), not the forgeable
-- Date header.
CREATE INDEX idx_messages_mailbox_created ON messages (mailbox_id, created_at, id);
