// iCalendar (RFC 5545) parsing for inbound iMIP invites and, later, the
// REPLY/REQUEST builders on the send side. Parsing lives in @mailbase/shared so
// the Email Worker (inbound) and the API (send) share one implementation; it is
// exposed as the `@mailbase/shared/calendar` subpath so it never lands in the
// web bundle (web reads events as JSON from the API, never raw .ics).
//
// We use ical.js — the only cleanly Cloudflare-Workers-safe parser (zero deps,
// no Node built-ins; decided in MAIL-24). Times are normalized to UTC; the
// original TZID is kept for display and all-day (VALUE=DATE) events are stored
// date-only (never timezone-shifted).

import ICAL from "ical.js";
import {
  type AttendeePartstat,
  ATTENDEE_PARTSTATS,
  type EventStatus,
  EVENT_STATUSES,
} from "./schema";

export interface ParsedCalendarAttendee {
  /** Bare address, lowercased (mailto: stripped). */
  addr: string;
  /** CN parameter, or '' when absent. */
  displayName: string;
  partstat: AttendeePartstat;
  /** iCalendar ROLE (e.g. REQ-PARTICIPANT), or '' when absent. */
  role: string;
}

export interface ParsedCalendarEvent {
  /** iCalendar METHOD, uppercased (REQUEST/REPLY/CANCEL/...); '' when absent. */
  method: string;
  uid: string;
  sequence: number;
  summary: string;
  description: string;
  location: string;
  /** Organizer address, lowercased (mailto: stripped); '' when absent. */
  organizerAddr: string;
  /** Start instant in UTC. For all-day events, the UTC midnight of the date. */
  startsAt: Date;
  /** End instant in UTC, or null when the invite carries no DTEND/DURATION. */
  endsAt: Date | null;
  allDay: boolean;
  /** Original IANA zone (e.g. "America/New_York"); '' for UTC/floating/all-day. */
  tzid: string;
  status: EventStatus;
  /** Raw RRULE value (e.g. "FREQ=WEEKLY;BYDAY=MO"); '' when non-recurring. */
  rrule: string;
  attendees: ParsedCalendarAttendee[];
}

/** First parameter value as a trimmed string ('' when absent). */
function paramString(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

/** Strip a `mailto:` (or other) scheme prefix and lowercase an address. */
function normalizeAddr(uri: string | null | undefined): string {
  if (!uri) return "";
  return uri.replace(/^mailto:/i, "").trim().toLowerCase();
}

function normalizeStatus(raw: string, method: string): EventStatus {
  if (method === "CANCEL") return "cancelled";
  const lowered = raw.trim().toLowerCase();
  return (EVENT_STATUSES as readonly string[]).includes(lowered)
    ? (lowered as EventStatus)
    : "confirmed";
}

function normalizePartstat(raw: string): AttendeePartstat {
  const lowered = raw.trim().toLowerCase();
  return (ATTENDEE_PARTSTATS as readonly string[]).includes(lowered)
    ? (lowered as AttendeePartstat)
    : "needs-action";
}

/** ical.js Time, narrowed to the fields we read (avoids using the namespace as
 *  a type). Months are 1-based. */
interface IcalTimeLike {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  toJSDate(): Date;
}

/** All-day (VALUE=DATE) times are stored as the UTC midnight of the date so a
 *  timezone never shifts the calendar day. */
function allDayToUtc(time: { year: number; month: number; day: number }): Date {
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

function isValidIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (wall-clock − UTC, in ms) of an IANA zone at a given UTC instant. */
function zoneOffsetMs(tzid: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
  const wall = Date.UTC(
    Number(m.year),
    Number(m.month) - 1,
    Number(m.day),
    Number(m.hour),
    Number(m.minute),
    Number(m.second),
  );
  return wall - utcMs;
}

/** The UTC instant for a wall-clock time in an IANA zone, resolved via Intl —
 *  the fallback when an invite carries a bare TZID with no VTIMEZONE block, which
 *  ical.js would otherwise treat as floating (MAIL-32). Refines once across a DST
 *  boundary. */
function wallClockInZoneToUtc(time: IcalTimeLike, tzid: string): Date {
  const asIfUtc = Date.UTC(
    time.year,
    time.month - 1,
    time.day,
    time.hour,
    time.minute,
    time.second,
  );
  const offset = zoneOffsetMs(tzid, asIfUtc);
  let utc = asIfUtc - offset;
  const refined = zoneOffsetMs(tzid, utc);
  if (refined !== offset) utc = asIfUtc - refined;
  return new Date(utc);
}

/** Resolve a VEVENT date-time to a UTC instant. All-day stays date-only; a TZID
 *  with a registered VTIMEZONE (or UTC/floating) is left to ical.js; a bare TZID
 *  with no VTIMEZONE is resolved from the IANA zone via Intl. */
function resolveInstant(
  time: IcalTimeLike,
  allDay: boolean,
  tzid: string,
): Date {
  if (allDay) return allDayToUtc(time);
  if (tzid && !ICAL.TimezoneService.has(tzid) && isValidIanaZone(tzid)) {
    return wallClockInZoneToUtc(time, tzid);
  }
  return time.toJSDate();
}

/**
 * Parse the first VEVENT out of an iCalendar document. Returns null on any
 * malformed input or when no VEVENT is present — callers treat that as "no
 * calendar" and must never let it drop the surrounding email.
 */
export function parseICalendar(text: string): ParsedCalendarEvent | null {
  try {
    const vcalendar = new ICAL.Component(ICAL.parse(text));

    // Register any embedded VTIMEZONEs so TZID-bearing times resolve to the
    // correct UTC instant.
    for (const vtz of vcalendar.getAllSubcomponents("vtimezone")) {
      const tzid = paramString(vtz.getFirstPropertyValue("tzid"));
      if (tzid && !ICAL.TimezoneService.has(tzid)) {
        ICAL.TimezoneService.register(vtz);
      }
    }

    const vevent = vcalendar.getFirstSubcomponent("vevent");
    if (!vevent) return null;

    const method = paramString(
      vcalendar.getFirstPropertyValue("method"),
    ).toUpperCase();
    const event = new ICAL.Event(vevent);

    const start = event.startDate;
    const allDay = start.isDate;
    const tzid = paramString(
      vevent.getFirstProperty("dtstart")?.getParameter("tzid"),
    );
    const startsAt = resolveInstant(start, allDay, tzid);

    const hasEnd =
      vevent.getFirstProperty("dtend") !== null ||
      vevent.getFirstProperty("duration") !== null;
    let endsAt: Date | null = null;
    if (hasEnd) {
      const end = event.endDate;
      // A DTEND has its own TZID; an end computed from DURATION inherits the
      // start's zone.
      const endTzid =
        paramString(vevent.getFirstProperty("dtend")?.getParameter("tzid")) ||
        tzid;
      endsAt = resolveInstant(end, end.isDate, endTzid);
    }

    const rruleProp = vevent.getFirstProperty("rrule");
    const rrule = rruleProp ? String(rruleProp.getFirstValue()) : "";

    const statusRaw = paramString(vevent.getFirstPropertyValue("status"));
    const sequenceRaw = vevent.getFirstPropertyValue("sequence");

    const attendees: ParsedCalendarAttendee[] = event.attendees.map((prop) => ({
      addr: normalizeAddr(String(prop.getFirstValue())),
      displayName: paramString(prop.getParameter("cn")),
      partstat: normalizePartstat(paramString(prop.getParameter("partstat"))),
      role: paramString(prop.getParameter("role")),
    }));

    return {
      method,
      uid: event.uid ?? "",
      sequence: typeof sequenceRaw === "number" ? sequenceRaw : 0,
      summary: event.summary ?? "",
      description: event.description ?? "",
      location: event.location ?? "",
      organizerAddr: normalizeAddr(event.organizer),
      startsAt,
      endsAt,
      allDay,
      tzid,
      status: normalizeStatus(statusRaw, method),
      rrule,
      attendees,
    };
  } catch {
    // Malformed calendar data must never throw into the inbound pipeline.
    return null;
  }
}

// --- iMIP REPLY builder (MAIL-29) ------------------------------------------

/** PARTSTAT values an attendee may reply with (uppercase, per RFC 5545). */
export type ReplyPartstat = "ACCEPTED" | "TENTATIVE" | "DECLINED";

export interface ReplyIcsInput {
  uid: string;
  sequence: number;
  /** Bare organizer address (no mailto:). */
  organizerAddr: string;
  /** The replying attendee's bare address (this mailbox). */
  attendeeAddr: string;
  attendeeName?: string;
  partstat: ReplyPartstat;
  summary?: string;
  startsAt: Date;
  endsAt?: Date | null;
  allDay?: boolean;
  /** When the reply is generated; goes out as DTSTAMP. */
  dtstamp: Date;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** UTC date-time in iCalendar basic format: YYYYMMDDTHHMMSSZ. */
function icsUtcDateTime(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/** UTC date in iCalendar DATE format: YYYYMMDD. */
function icsDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/** Escape a TEXT value (RFC 5545 §3.3.11). */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** A CN parameter value, double-quoted when it contains a special char. */
function paramValue(s: string): string {
  return /[",;:]/.test(s) ? `"${s.replace(/"/g, "")}"` : s;
}

/**
 * Build a `METHOD:REPLY` iCalendar document for an attendee's RSVP (iMIP, RFC
 * 6047 / 5546). It echoes the event UID/SEQUENCE and carries the single
 * replying ATTENDEE line with its new PARTSTAT, addressed to the organizer.
 * Identity is the UID, never the email Message-ID (our provider rewrites that).
 */
export function buildReplyIcs(input: ReplyIcsInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//mailbase//Calendar//EN",
    "VERSION:2.0",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${icsUtcDateTime(input.dtstamp)}`,
  ];
  if (input.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(input.startsAt)}`);
    if (input.endsAt) lines.push(`DTEND;VALUE=DATE:${icsDate(input.endsAt)}`);
  } else {
    lines.push(`DTSTART:${icsUtcDateTime(input.startsAt)}`);
    if (input.endsAt) lines.push(`DTEND:${icsUtcDateTime(input.endsAt)}`);
  }
  if (input.summary) lines.push(`SUMMARY:${escapeText(input.summary)}`);
  lines.push(`ORGANIZER:mailto:${input.organizerAddr}`);
  const cn = input.attendeeName
    ? `;CN=${paramValue(input.attendeeName)}`
    : "";
  lines.push(
    `ATTENDEE${cn};PARTSTAT=${input.partstat}:mailto:${input.attendeeAddr}`,
  );
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

// --- iMIP REQUEST / CANCEL builder (MAIL-30) -------------------------------

export interface EventIcsAttendee {
  addr: string;
  displayName?: string;
}

export interface EventIcsInput {
  /** REQUEST for a new/updated invite, CANCEL to call it off. */
  method: "REQUEST" | "CANCEL";
  uid: string;
  sequence: number;
  organizerAddr: string;
  organizerName?: string;
  summary?: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt?: Date | null;
  allDay?: boolean;
  attendees: EventIcsAttendee[];
  /** When the message is generated; goes out as DTSTAMP. */
  dtstamp: Date;
}

/**
 * Build a `METHOD:REQUEST` (invite / update) or `METHOD:CANCEL` iCalendar that
 * the organizer sends to attendees (iMIP). REQUEST asks each attendee to RSVP
 * (RSVP=TRUE, PARTSTAT=NEEDS-ACTION); CANCEL marks the event STATUS:CANCELLED.
 * Times are emitted in UTC (or as a DATE for all-day), which every client
 * resolves unambiguously — no VTIMEZONE needed.
 */
export function buildEventIcs(input: EventIcsInput): string {
  const cancel = input.method === "CANCEL";
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//mailbase//Calendar//EN",
    "VERSION:2.0",
    `METHOD:${input.method}`,
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${icsUtcDateTime(input.dtstamp)}`,
  ];
  if (input.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(input.startsAt)}`);
    if (input.endsAt) lines.push(`DTEND;VALUE=DATE:${icsDate(input.endsAt)}`);
  } else {
    lines.push(`DTSTART:${icsUtcDateTime(input.startsAt)}`);
    if (input.endsAt) lines.push(`DTEND:${icsUtcDateTime(input.endsAt)}`);
  }
  if (input.summary) lines.push(`SUMMARY:${escapeText(input.summary)}`);
  if (input.description) {
    lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  }
  if (input.location) lines.push(`LOCATION:${escapeText(input.location)}`);
  lines.push(`STATUS:${cancel ? "CANCELLED" : "CONFIRMED"}`);

  const orgCn = input.organizerName
    ? `;CN=${paramValue(input.organizerName)}`
    : "";
  lines.push(`ORGANIZER${orgCn}:mailto:${input.organizerAddr}`);

  for (const a of input.attendees) {
    const cn = a.displayName ? `;CN=${paramValue(a.displayName)}` : "";
    // CANCEL just lists who it affects; REQUEST asks for an RSVP.
    const params = cancel
      ? ";ROLE=REQ-PARTICIPANT"
      : ";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE";
    lines.push(`ATTENDEE${cn}${params}:mailto:${a.addr}`);
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
