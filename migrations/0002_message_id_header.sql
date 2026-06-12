-- Migration 0002: store each message's RFC 5322 Message-ID so replies can be
-- threaded by looking up the ids named in References/In-Reply-To headers
-- (docs/DESIGN.md §4). Stored without the surrounding angle brackets.
ALTER TABLE messages ADD COLUMN message_id_header TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_messages_mailbox_message_id ON messages(mailbox_id, message_id_header);
