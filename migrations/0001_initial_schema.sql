-- Migration 0001: initial schema (docs/DESIGN.md §4)
-- Conventions: TEXT UUID primary keys, INTEGER unix-epoch timestamps,
-- INTEGER 0/1 booleans, JSON stored as TEXT.

-- Note: domains.catch_all_mailbox_id references mailboxes(id), which is created
-- below. SQLite resolves foreign keys lazily, so the forward reference is valid.
CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  catch_all_mailbox_id TEXT REFERENCES mailboxes(id),
  reject_unknown INTEGER NOT NULL DEFAULT 0,
  resend_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email_login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (domain_id, name)
);
CREATE INDEX idx_mailboxes_domain ON mailboxes(domain_id);

CREATE TABLE addresses (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  UNIQUE (domain_id, local_part)
);
CREATE INDEX idx_addresses_mailbox ON addresses(mailbox_id);

CREATE TABLE mailbox_members (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX idx_mailbox_members_user ON mailbox_members(user_id);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, address_id)
);
CREATE INDEX idx_identities_user ON identities(user_id);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  subject_norm TEXT NOT NULL,
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_threads_mailbox_recency ON threads(mailbox_id, last_message_at DESC);
CREATE INDEX idx_threads_mailbox_subject ON threads(mailbox_id, subject_norm);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  thread_id TEXT REFERENCES threads(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_addr TEXT NOT NULL,
  to_addrs TEXT NOT NULL DEFAULT '[]', -- JSON array of addresses
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  date INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  folder TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox', 'sent', 'archive', 'trash', 'spam')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_messages_mailbox_folder_date ON messages(mailbox_id, folder, date DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

-- Full-text search over messages, kept in sync by triggers (external-content FTS5).
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  from_addr,
  body_text,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER messages_fts_after_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_addr, body_text)
  VALUES (new.rowid, new.subject, new.from_addr, new.body_text);
END;

CREATE TRIGGER messages_fts_after_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, body_text)
  VALUES ('delete', old.rowid, old.subject, old.from_addr, old.body_text);
END;

CREATE TRIGGER messages_fts_after_update AFTER UPDATE OF subject, from_addr, body_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, body_text)
  VALUES ('delete', old.rowid, old.subject, old.from_addr, old.body_text);
  INSERT INTO messages_fts(rowid, subject, from_addr, body_text)
  VALUES (new.rowid, new.subject, new.from_addr, new.body_text);
END;
