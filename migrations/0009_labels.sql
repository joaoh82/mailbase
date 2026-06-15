-- Migration 0009: user-defined message labels (MAIL-16).
--
-- Gmail-style labels: a flat, many-to-many tagging layer on top of the existing
-- folder enum. Labels are additive — the folder model (inbox/sent/archive/
-- trash/spam) is untouched; a message can carry any number of labels in any
-- folder.
--
-- Scoping: a label belongs to a shared mailbox, so it is visible to and
-- managed by every member of that mailbox — exactly like signatures, members,
-- and identities. Authorization therefore reuses the same mailbox-membership
-- checks (hasMailboxAccess); there are no per-user/private labels. A label may
-- only be applied to a message in the same mailbox, so labels never cross the
-- multi-domain boundary.

CREATE TABLE labels (
  id text PRIMARY KEY,
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Optional UI color: '' (default chip styling) or a "#rrggbb" hex value.
  color text NOT NULL DEFAULT '',
  created_at integer NOT NULL DEFAULT (unixepoch())
);

-- One label name per mailbox; the apply menu and sidebar dedupe by name.
CREATE UNIQUE INDEX labels_mailbox_id_name_unique ON labels (mailbox_id, name);
CREATE INDEX idx_labels_mailbox ON labels (mailbox_id);

CREATE TABLE message_labels (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id text NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);

-- "labels on message Y" is served by the composite PK's leading message_id.
-- Add the reverse index for "messages with label X" (the label-filtered list).
CREATE INDEX idx_message_labels_label ON message_labels (label_id);
