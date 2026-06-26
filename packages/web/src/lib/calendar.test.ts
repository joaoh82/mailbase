import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../api";
import {
  addDays,
  dateInputToIso,
  eventDayKey,
  eventsByDay,
  formatEventTime,
  isEmail,
  isOrganizer,
  isoToLocalInput,
  localDayKey,
  localInputToIso,
  monthMatrix,
  parseAttendeeList,
  periodRange,
  sameDay,
  shiftAnchor,
  sortedEvents,
  startOfMonth,
  startOfWeek,
  weekDays,
} from "./calendar";

function ev(
  partial: Partial<CalendarEvent> & { id: string; startsAt: string },
): CalendarEvent {
  return {
    mailboxId: "mbx",
    messageId: null,
    uid: partial.id,
    sequence: 0,
    method: "REQUEST",
    status: "confirmed",
    summary: "",
    description: "",
    location: "",
    organizerAddr: "",
    endsAt: null,
    allDay: false,
    tzid: "",
    rrule: "",
    attendees: [],
    ...partial,
  };
}

// July 1 2026 is a Wednesday, so the surrounding Sunday is June 28 2026.
const ANCHOR = new Date(2026, 6, 15);

describe("monthMatrix", () => {
  it("is a 6×7 grid starting on a Sunday and containing the 1st", () => {
    const weeks = monthMatrix(ANCHOR);
    expect(weeks).toHaveLength(6);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]![0]!.getDay()).toBe(0);
    expect(weeks.flat().some((d) => sameDay(d, new Date(2026, 6, 1)))).toBe(true);
  });

  it("has consecutive days", () => {
    const flat = monthMatrix(ANCHOR).flat();
    for (let i = 1; i < flat.length; i++) {
      expect(sameDay(flat[i]!, addDays(flat[i - 1]!, 1))).toBe(true);
    }
  });
});

describe("weekDays", () => {
  it("returns seven consecutive days from the week's Sunday", () => {
    const days = weekDays(ANCHOR);
    expect(days).toHaveLength(7);
    expect(days[0]!.getDay()).toBe(0);
    expect(sameDay(days[0]!, startOfWeek(ANCHOR))).toBe(true);
    expect(sameDay(days[6]!, addDays(days[0]!, 6))).toBe(true);
  });
});

describe("periodRange", () => {
  it("month spans the 42-day grid from the leading Sunday", () => {
    const { from, to } = periodRange("month", ANCHOR);
    expect(sameDay(from, startOfWeek(startOfMonth(ANCHOR)))).toBe(true);
    expect(sameDay(to, addDays(from, 42))).toBe(true);
  });

  it("week spans seven days from the Sunday", () => {
    const { from, to } = periodRange("week", ANCHOR);
    expect(sameDay(from, startOfWeek(ANCHOR))).toBe(true);
    expect(sameDay(to, addDays(from, 7))).toBe(true);
  });

  it("agenda spans 30 days from the anchor day", () => {
    const { from, to } = periodRange("agenda", ANCHOR);
    expect(sameDay(to, addDays(from, 30))).toBe(true);
  });
});

describe("shiftAnchor", () => {
  it("steps a month, a week, or 30 days", () => {
    expect(shiftAnchor("month", ANCHOR, 1).getMonth()).toBe(7);
    expect(shiftAnchor("month", ANCHOR, -1).getMonth()).toBe(5);
    expect(sameDay(shiftAnchor("week", ANCHOR, 1), addDays(ANCHOR, 7))).toBe(true);
    expect(sameDay(shiftAnchor("agenda", ANCHOR, -1), addDays(ANCHOR, -30))).toBe(
      true,
    );
  });
});

describe("eventDayKey", () => {
  it("places an all-day event on its UTC date, never shifted by timezone", () => {
    const e = ev({ id: "a", startsAt: "2026-07-20T00:00:00.000Z", allDay: true });
    expect(eventDayKey(e)).toBe("2026-07-20");
  });

  it("places a timed event on the local day of its start", () => {
    const e = ev({ id: "b", startsAt: "2026-07-15T13:00:00.000Z" });
    expect(eventDayKey(e)).toBe(localDayKey(new Date(e.startsAt)));
  });
});

describe("eventsByDay", () => {
  it("groups events by day and sorts each day by start", () => {
    const a = ev({ id: "a", startsAt: "2026-07-20T15:00:00.000Z", allDay: true });
    const b = ev({ id: "b", startsAt: "2026-07-20T09:00:00.000Z", allDay: true });
    const map = eventsByDay([a, b]);
    expect(map.get("2026-07-20")!.map((e) => e.id)).toEqual(["b", "a"]);
  });
});

describe("sortedEvents", () => {
  it("orders chronologically without mutating the input", () => {
    const input = [
      ev({ id: "late", startsAt: "2026-07-20T10:00:00Z" }),
      ev({ id: "early", startsAt: "2026-07-19T10:00:00Z" }),
    ];
    expect(sortedEvents(input).map((e) => e.id)).toEqual(["early", "late"]);
    expect(input[0]!.id).toBe("late");
  });
});

describe("formatEventTime", () => {
  it("labels all-day events", () => {
    expect(formatEventTime(ev({ id: "a", startsAt: "x", allDay: true }))).toBe(
      "All day",
    );
  });

  it("shows a range when there is an end, a single time otherwise", () => {
    const ranged = ev({
      id: "r",
      startsAt: "2026-07-15T13:00:00Z",
      endsAt: "2026-07-15T13:30:00Z",
    });
    expect(formatEventTime(ranged)).toContain("–");
    const single = ev({ id: "s", startsAt: "2026-07-15T13:00:00Z" });
    expect(formatEventTime(single)).not.toContain("–");
  });
});

describe("composer helpers", () => {
  it("splits an attendee field on commas / semicolons / whitespace", () => {
    expect(
      parseAttendeeList("alice@x.com, bob@y.com\n c@z.com; d@w.com"),
    ).toEqual(["alice@x.com", "bob@y.com", "c@z.com", "d@w.com"]);
    expect(parseAttendeeList("   ")).toEqual([]);
  });

  it("validates email shape", () => {
    expect(isEmail("a@b.com")).toBe(true);
    expect(isEmail("nope")).toBe(false);
    expect(isEmail("a@b")).toBe(false);
  });

  it("converts a date input to UTC midnight without shifting", () => {
    expect(dateInputToIso("2026-07-20")).toBe("2026-07-20T00:00:00.000Z");
    expect(dateInputToIso("nope")).toBeNull();
  });

  it("round-trips an instant through the datetime-local input", () => {
    // local→iso→local preserves the instant (truncated to the minute).
    const iso = "2026-07-15T13:00:00.000Z";
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
    expect(localInputToIso("")).toBeNull();
  });

  it("detects whether the viewer organizes an event", () => {
    const attendee = (addr: string, isSelf: boolean) => ({
      addr,
      displayName: "",
      partstat: "needs-action",
      role: "",
      isSelf,
    });
    // We are the organizer: our self line is the organizer address.
    expect(
      isOrganizer(
        ev({
          id: "a",
          startsAt: "2026-07-15T13:00:00Z",
          organizerAddr: "josh@x.com",
          attendees: [
            attendee("josh@x.com", true),
            attendee("alice@y.com", false),
          ],
        }),
      ),
    ).toBe(true);
    // We're just an invitee (self line ≠ organizer).
    expect(
      isOrganizer(
        ev({
          id: "b",
          startsAt: "2026-07-15T13:00:00Z",
          organizerAddr: "alice@y.com",
          attendees: [attendee("josh@x.com", true)],
        }),
      ),
    ).toBe(false);
    // No self attendee at all.
    expect(
      isOrganizer(
        ev({ id: "c", startsAt: "2026-07-15T13:00:00Z", organizerAddr: "alice@y.com" }),
      ),
    ).toBe(false);
  });
});
