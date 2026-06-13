-- Migration 0005: outbound delivery tracking (docs/DESIGN.md §5 "Send").
-- When we send through a provider (Resend), it returns its own id for the
-- accepted message; bounce/complaint webhooks reference that id. We store it
-- so the webhook can find the local copy, and a delivery_status the webmail
-- surfaces ('' for inbound and freshly-sent mail, then 'bounced'/'complained').
ALTER TABLE messages ADD COLUMN provider_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_messages_provider_message_id ON messages(provider_message_id);
