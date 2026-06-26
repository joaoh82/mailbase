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

/** All-day (VALUE=DATE) times are stored as the UTC midnight of the date so a
 *  timezone never shifts the calendar day. ical.js Time months are 1-based. */
function allDayToUtc(time: {
  year: number;
  month: number;
  day: number;
}): Date {
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
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
    const tzid = paramString(vevent.getFirstProperty("dtstart")?.getParameter("tzid"));
    const startsAt = allDay ? allDayToUtc(start) : start.toJSDate();

    const hasEnd =
      vevent.getFirstProperty("dtend") !== null ||
      vevent.getFirstProperty("duration") !== null;
    let endsAt: Date | null = null;
    if (hasEnd) {
      const end = event.endDate;
      endsAt = end.isDate ? allDayToUtc(end) : end.toJSDate();
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
