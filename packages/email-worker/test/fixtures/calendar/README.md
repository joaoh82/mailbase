# Calendar (iCalendar / iMIP) test fixtures

Hand-authored `.ics` payloads for the inbound calendar parser (MAIL-26) and the
send/RSVP builders (MAIL-29/30). They cover the shapes the parser must handle:

| File | METHOD | Notes |
|------|--------|-------|
| `request-timezoned.ics` | REQUEST | `DTSTART;TZID=America/New_York` + a `VTIMEZONE` block |
| `request-all-day.ics` | REQUEST | `DTSTART;VALUE=DATE` — all-day, must NOT be timezone-shifted |
| `request-recurring.ics` | REQUEST | weekly `RRULE` — v1 stores the raw rule, renders the master only |
| `reply-accepted.ics` | REPLY | a single `ATTENDEE` with `PARTSTAT=ACCEPTED` |
| `cancel.ics` | CANCEL | same `UID`, higher `SEQUENCE`, `STATUS:CANCELLED` |

> These are **synthetic but standards-shaped**. Before MAIL-26 lands, also drop in
> **real exports** captured from Gmail, Outlook/Microsoft 365, and Apple Calendar
> (REQUEST/REPLY/CANCEL) — real senders vary in folding, params, and `VTIMEZONE`
> presence, and that variance is what the parser tests must pin down. Capture them via
> "Show original" (Gmail) / "View source" and save the `text/calendar` part verbatim.

Reconciliation the parser/store must honor: a later REQUEST with the same `UID` and a
higher `SEQUENCE` replaces the event; a `CANCEL` (or `STATUS:CANCELLED`) flips it to
cancelled. Identity is the iCalendar `UID`, never the email `Message-ID`.
