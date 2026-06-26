-- Migration 0011: calendar events from iCalendar/iMIP invites (MAIL-25, Phase 7).
--
-- Inbound meeting invites (RFC 6047 iMIP carrying RFC 5545 iCalendar) and the
-- invites we originate are stored here. The raw .ics stays in R2 (the source of
-- truth, like the raw .eml); these rows are derived and rebuildable from it.
--
-- Identity is the iCalendar UID, NOT the email Message-ID (our send provider
-- rewrites the latter). A re-sent/updated invite reconciles by (mailbox_id, uid):
-- a higher SEQUENCE supersedes the existing row, a CANCEL flips status to
-- 'cancelled'. Scoped by mailbox_id like every other table, so events never cross
-- the multi-domain boundary. Times are stored as epoch seconds in UTC; tzid keeps
-- the original zone for display, and all_day (DTSTART;VALUE=DATE) events are
-- floating and must never be timezone-shifted.

CREATE TABLE events (
  id text PRIMARY KEY,
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  -- The stored message this invite arrived on; NULL for invites we originate, or
  -- once that message is deleted (so purging mail keeps the calendar event).
  message_id text REFERENCES messages(id) ON DELETE SET NULL,
  -- iCalendar UID — stable identity across updates and cancellations.
  uid text NOT NULL,
  -- Revision counter; a higher value supersedes an existing row with the same UID.
  sequence integer NOT NULL DEFAULT 0,
  organizer_addr text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  -- Start/end as epoch seconds in UTC. ends_at is NULL when the invite carries no
  -- DTEND/DURATION.
  starts_at integer NOT NULL,
  ends_at integer,
  -- All-day (DTSTART;VALUE=DATE): floating, never timezone-shifted.
  all_day integer NOT NULL DEFAULT 0,
  -- Original IANA zone (e.g. "America/New_York") for display; '' for UTC,
  -- floating, or all-day events.
  tzid text NOT NULL DEFAULT '',
  -- 'confirmed' | 'cancelled' | 'tentative'.
  status text NOT NULL DEFAULT 'confirmed',
  -- Raw RRULE, stored verbatim; '' = non-recurring. v1 renders the master
  -- instance only (no expansion).
  rrule text NOT NULL DEFAULT '',
  -- iCalendar METHOD the row was last touched by (REQUEST/REPLY/CANCEL/...).
  method text NOT NULL DEFAULT '',
  -- R2 key of the raw .ics; '' until stored.
  raw_ics_r2_key text NOT NULL DEFAULT '',
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch())
);

-- Reconcile a re-sent/updated invite by UID within a mailbox.
CREATE UNIQUE INDEX events_mailbox_id_uid_unique ON events (mailbox_id, uid);
-- Calendar range queries: a mailbox's events across a [from, to] window.
CREATE INDEX idx_events_mailbox_starts ON events (mailbox_id, starts_at);
-- "the event for this message" — the reading-pane RSVP card.
CREATE INDEX idx_events_message ON events (message_id);

CREATE TABLE event_attendees (
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  addr text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  -- 'needs-action' | 'accepted' | 'tentative' | 'declined'.
  partstat text NOT NULL DEFAULT 'needs-action',
  -- iCalendar ROLE (e.g. REQ-PARTICIPANT); '' when unset.
  role text NOT NULL DEFAULT '',
  -- True for the mailbox's own attendee line — drives RSVP rendering and the
  -- PARTSTAT we echo in a REPLY.
  is_self integer NOT NULL DEFAULT 0,
  -- One row per attendee address per event; "attendees of event X" is served by
  -- the leading event_id.
  PRIMARY KEY (event_id, addr)
);
