-- Seed one test domain with one mailbox, two addresses, and catch-all enabled.
--
-- The __DOMAIN__ and __MAILBOX__ tokens are substituted by `make seed-local` /
-- `make seed-remote` (e.g. `make seed-local DOMAIN=example.com MAILBOX=josh`),
-- or replace them by hand and run:
--   npx wrangler d1 execute mailbase --local --file scripts/seed.sql
--
-- Idempotent: fixed ids + INSERT OR IGNORE, safe to re-run.

INSERT OR IGNORE INTO domains (id, name, reject_unknown)
VALUES ('seed-domain', lower('__DOMAIN__'), 0);

INSERT OR IGNORE INTO mailboxes (id, domain_id, name)
VALUES ('seed-mailbox', 'seed-domain', lower('__MAILBOX__'));

-- __MAILBOX__@__DOMAIN__ plus a hello@ alias, both into the same mailbox.
INSERT OR IGNORE INTO addresses (id, domain_id, local_part, mailbox_id) VALUES
  ('seed-address-primary', 'seed-domain', lower('__MAILBOX__'), 'seed-mailbox'),
  ('seed-address-hello', 'seed-domain', 'hello', 'seed-mailbox');

-- Anything else @__DOMAIN__ lands in the same mailbox via catch-all.
UPDATE domains SET catch_all_mailbox_id = 'seed-mailbox' WHERE id = 'seed-domain';
