import { describe, expect, it } from "vitest";
import {
  buildEventIcs,
  buildReplyIcs,
  parseICalendar,
} from "../src/icalendar";

// Inline, standards-shaped iCalendar payloads. To harden the parser against a
// real sender, paste its `text/calendar` part (Gmail "Show original" / "View
// source") in as another constant and add a case below.

const TIMEZONED_REQUEST = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260715T090000",
  "DTEND;TZID=America/New_York:20260715T093000",
  "DTSTAMP:20260626T120000Z",
  "ORGANIZER;CN=Alice Organizer:mailto:alice@gmail.com",
  "UID:tz-event-001@google.com",
  "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Josh:mailto:josh@example.com",
  "ATTENDEE;PARTSTAT=ACCEPTED;CN=Alice Organizer:mailto:alice@gmail.com",
  "SEQUENCE:0",
  "STATUS:CONFIRMED",
  "SUMMARY:Project sync",
  "LOCATION:Conference Room A",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const ALL_DAY_REQUEST = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Microsoft Corporation//Outlook//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20260720",
  "DTEND;VALUE=DATE:20260721",
  "DTSTAMP:20260626T120000Z",
  "ORGANIZER;CN=Bob Boss:mailto:bob@contoso.com",
  "UID:allday-event-002@contoso.com",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Josh:mailto:josh@example.com",
  "SEQUENCE:0",
  "SUMMARY:Company holiday",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const RECURRING_REQUEST = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Apple Inc.//macOS//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/London",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0100",
  "TZNAME:BST",
  "DTSTART:19700329T010000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0000",
  "TZNAME:GMT",
  "DTSTART:19701025T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/London:20260706T100000",
  "DTEND;TZID=Europe/London:20260706T103000",
  "DTSTAMP:20260626T120000Z",
  "ORGANIZER;CN=Carol Lead:mailto:carol@example.org",
  "UID:recurring-event-003@example.org",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Josh:mailto:josh@example.com",
  "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10",
  "SEQUENCE:0",
  "SUMMARY:Monday standup",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const REPLY_ACCEPTED = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar//EN",
  "VERSION:2.0",
  "METHOD:REPLY",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260715T090000",
  "DTSTAMP:20260626T130000Z",
  "ORGANIZER;CN=Alice Organizer:mailto:alice@gmail.com",
  "UID:tz-event-001@google.com",
  "ATTENDEE;PARTSTAT=ACCEPTED;CN=Josh:mailto:josh@example.com",
  "SEQUENCE:0",
  "SUMMARY:Accepted: Project sync",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const CANCEL = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar//EN",
  "VERSION:2.0",
  "METHOD:CANCEL",
  "BEGIN:VEVENT",
  "DTSTART:20260715T130000Z",
  "DTSTAMP:20260626T140000Z",
  "ORGANIZER;CN=Alice Organizer:mailto:alice@gmail.com",
  "UID:tz-event-001@google.com",
  "ATTENDEE;CN=Josh:mailto:josh@example.com",
  "SEQUENCE:1",
  "STATUS:CANCELLED",
  "SUMMARY:Cancelled: Project sync",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseICalendar", () => {
  it("converts a TZID start time to the correct UTC instant", () => {
    const event = parseICalendar(TIMEZONED_REQUEST)!;
    expect(event).not.toBeNull();
    expect(event.method).toBe("REQUEST");
    expect(event.uid).toBe("tz-event-001@google.com");
    expect(event.summary).toBe("Project sync");
    expect(event.location).toBe("Conference Room A");
    expect(event.organizerAddr).toBe("alice@gmail.com");
    expect(event.allDay).toBe(false);
    expect(event.tzid).toBe("America/New_York");
    // 09:00 EDT (UTC-4) on 2026-07-15 -> 13:00 UTC.
    expect(event.startsAt.toISOString()).toBe("2026-07-15T13:00:00.000Z");
    expect(event.endsAt?.toISOString()).toBe("2026-07-15T13:30:00.000Z");
    expect(event.status).toBe("confirmed");
    expect(event.rrule).toBe("");
  });

  it("captures attendees with a normalized partstat", () => {
    const event = parseICalendar(TIMEZONED_REQUEST)!;
    const josh = event.attendees.find((a) => a.addr === "josh@example.com");
    expect(josh).toBeDefined();
    expect(josh!.partstat).toBe("needs-action");
    expect(josh!.role).toBe("REQ-PARTICIPANT");
    const alice = event.attendees.find((a) => a.addr === "alice@gmail.com");
    expect(alice!.partstat).toBe("accepted");
  });

  it("stores all-day events date-only without a timezone shift", () => {
    const event = parseICalendar(ALL_DAY_REQUEST)!;
    expect(event.allDay).toBe(true);
    expect(event.tzid).toBe("");
    expect(event.startsAt.toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(event.endsAt?.toISOString()).toBe("2026-07-21T00:00:00.000Z");
    expect(event.summary).toBe("Company holiday");
  });

  it("keeps the raw RRULE for recurring events without expanding it", () => {
    const event = parseICalendar(RECURRING_REQUEST)!;
    expect(event.rrule).toContain("FREQ=WEEKLY");
    expect(event.tzid).toBe("Europe/London");
    // 10:00 BST (UTC+1) on 2026-07-06 -> 09:00 UTC.
    expect(event.startsAt.toISOString()).toBe("2026-07-06T09:00:00.000Z");
  });

  it("reads a REPLY's PARTSTAT", () => {
    const event = parseICalendar(REPLY_ACCEPTED)!;
    expect(event.method).toBe("REPLY");
    expect(event.uid).toBe("tz-event-001@google.com");
    expect(event.attendees[0]?.partstat).toBe("accepted");
  });

  it("marks a CANCEL as cancelled and carries the bumped sequence", () => {
    const event = parseICalendar(CANCEL)!;
    expect(event.method).toBe("CANCEL");
    expect(event.status).toBe("cancelled");
    expect(event.sequence).toBe(1);
    expect(event.uid).toBe("tz-event-001@google.com");
  });

  it("returns null on malformed or non-calendar input", () => {
    expect(parseICalendar("this is not a calendar")).toBeNull();
    expect(parseICalendar("")).toBeNull();
    // A VCALENDAR with no VEVENT.
    expect(
      parseICalendar("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"),
    ).toBeNull();
  });
});

describe("buildReplyIcs", () => {
  const base = {
    uid: "evt-1@example.com",
    sequence: 2,
    organizerAddr: "alice@gmail.com",
    attendeeAddr: "josh@testdomain.com",
    attendeeName: "Josh",
    startsAt: new Date("2026-07-15T13:00:00Z"),
    endsAt: new Date("2026-07-15T13:30:00Z"),
    dtstamp: new Date("2026-06-26T12:00:00Z"),
  };

  it("produces a METHOD:REPLY that parses back to the same UID/sequence/partstat", () => {
    const ics = buildReplyIcs({ ...base, partstat: "ACCEPTED" });
    expect(ics).toContain("METHOD:REPLY");
    expect(ics).toContain("PARTSTAT=ACCEPTED");
    expect(ics).toContain("DTSTART:20260715T130000Z");

    const parsed = parseICalendar(ics)!;
    expect(parsed.method).toBe("REPLY");
    expect(parsed.uid).toBe("evt-1@example.com");
    expect(parsed.sequence).toBe(2);
    expect(parsed.organizerAddr).toBe("alice@gmail.com");
    expect(parsed.attendees).toHaveLength(1);
    expect(parsed.attendees[0]).toMatchObject({
      addr: "josh@testdomain.com",
      partstat: "accepted",
    });
  });

  it("carries DECLINED / TENTATIVE through faithfully", () => {
    expect(parseICalendar(buildReplyIcs({ ...base, partstat: "DECLINED" }))!.attendees[0]!.partstat).toBe(
      "declined",
    );
    expect(parseICalendar(buildReplyIcs({ ...base, partstat: "TENTATIVE" }))!.attendees[0]!.partstat).toBe(
      "tentative",
    );
  });

  it("writes an all-day reply as a DATE value", () => {
    const ics = buildReplyIcs({
      ...base,
      partstat: "ACCEPTED",
      allDay: true,
      startsAt: new Date("2026-07-20T00:00:00Z"),
      endsAt: new Date("2026-07-21T00:00:00Z"),
    });
    expect(ics).toContain("DTSTART;VALUE=DATE:20260720");
    expect(parseICalendar(ics)!.allDay).toBe(true);
  });
});

describe("buildEventIcs", () => {
  const base = {
    uid: "new-evt-1@testdomain.com",
    organizerAddr: "josh@testdomain.com",
    organizerName: "Josh",
    summary: "Design review",
    description: "Bring the mocks.",
    location: "Room B",
    startsAt: new Date("2026-09-01T15:00:00Z"),
    endsAt: new Date("2026-09-01T16:00:00Z"),
    attendees: [
      { addr: "alice@gmail.com", displayName: "Alice" },
      { addr: "bob@contoso.com" },
    ],
    dtstamp: new Date("2026-06-26T12:00:00Z"),
  };

  it("builds a REQUEST that parses back with organizer and all attendees", () => {
    const ics = buildEventIcs({ ...base, method: "REQUEST", sequence: 0 });
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics).toContain("RSVP=TRUE");
    expect(ics).toContain("DTSTART:20260901T150000Z");

    const parsed = parseICalendar(ics)!;
    expect(parsed.method).toBe("REQUEST");
    expect(parsed.uid).toBe("new-evt-1@testdomain.com");
    expect(parsed.organizerAddr).toBe("josh@testdomain.com");
    expect(parsed.summary).toBe("Design review");
    expect(parsed.location).toBe("Room B");
    expect(parsed.attendees.map((a) => a.addr).sort()).toEqual([
      "alice@gmail.com",
      "bob@contoso.com",
    ]);
    expect(
      parsed.attendees.every((a) => a.partstat === "needs-action"),
    ).toBe(true);
  });

  it("builds a CANCEL with a bumped sequence and cancelled status", () => {
    const ics = buildEventIcs({ ...base, method: "CANCEL", sequence: 1 });
    expect(ics).toContain("METHOD:CANCEL");
    const parsed = parseICalendar(ics)!;
    expect(parsed.method).toBe("CANCEL");
    expect(parsed.status).toBe("cancelled");
    expect(parsed.sequence).toBe(1);
  });

  it("escapes TEXT fields (no raw semicolons/commas leak into values)", () => {
    const ics = buildEventIcs({
      ...base,
      method: "REQUEST",
      sequence: 0,
      summary: "Lunch; then talk, briefly",
    });
    expect(ics).toContain("SUMMARY:Lunch\\; then talk\\, briefly");
    expect(parseICalendar(ics)!.summary).toBe("Lunch; then talk, briefly");
  });
});
