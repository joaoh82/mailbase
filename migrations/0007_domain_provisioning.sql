-- Migration 0007: Phase 5 multi-domain automation.
--
-- Adding a domain from the admin UI provisions it on two external providers:
-- Cloudflare (a zone + Email Routing + a catch-all rule to the email worker) and
-- Resend (a sending domain + its DKIM/SPF DNS records). We persist the provider
-- handles so the UI can later show live verification status and re-run
-- provisioning without re-creating anything.
--
-- Existing, manually-seeded domains have empty handles (''), which the UI reads
-- as "managed manually" — they keep working exactly as before.

ALTER TABLE domains ADD COLUMN cloudflare_zone_id TEXT NOT NULL DEFAULT '';
ALTER TABLE domains ADD COLUMN resend_domain_id TEXT NOT NULL DEFAULT '';
