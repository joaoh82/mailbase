-- Migration 0008: per-identity and per-mailbox email signatures (MAIL-4).
--
-- A signature is HTML appended to the bottom of outgoing mail (the same
-- allowlisted HTML the composer produces, sanitized on the way out). It is
-- resolved per send-as identity at compose time: an identity's own signature
-- wins; if it is empty, the owning mailbox's default is used; if both are
-- empty, no signature is added. Both columns default to '' so existing
-- identities/mailboxes simply have no signature until one is set.
ALTER TABLE identities ADD COLUMN signature TEXT NOT NULL DEFAULT '';
ALTER TABLE mailboxes ADD COLUMN signature TEXT NOT NULL DEFAULT '';
