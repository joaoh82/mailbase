-- Migration 0003: enforce one copy of a message per mailbox at the database
-- level. The worker's pre-insert duplicate check races when Email Routing
-- delivers to several aliases of the same mailbox concurrently (one
-- invocation per envelope recipient); a unique index closes that window.

-- Remove existing duplicates first (keep the earliest copy). The FTS delete
-- triggers keep messages_fts in sync; orphaned R2 blobs are harmless.
DELETE FROM messages
WHERE message_id_header != ''
  AND rowid NOT IN (
    SELECT MIN(rowid) FROM messages
    WHERE message_id_header != ''
    GROUP BY mailbox_id, message_id_header
  );

-- Drop threads left without messages, then recount the rest.
DELETE FROM threads
WHERE id NOT IN (SELECT thread_id FROM messages WHERE thread_id IS NOT NULL);
UPDATE threads
SET message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = threads.id);

-- '' means "no Message-ID header"; those can never be deduped, so exempt them.
CREATE UNIQUE INDEX idx_messages_mailbox_msgid_unique
  ON messages(mailbox_id, message_id_header)
  WHERE message_id_header != '';
