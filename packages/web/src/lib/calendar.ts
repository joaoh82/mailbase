// Pure date/grid helpers for the Calendar view (MAIL-28). Kept free of React so
// the fiddly bits — month grids, all-day day-placement, fetch windows — are unit
// tested directly. Weeks start on Sunday (the common default; no locale config
// in the app yet).

import type { CalendarEvent } from "../api";

export type CalendarView = "month" | "week" | "agenda";

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  return addDays(x, -x.getDay());
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar-day key, "YYYY-MM-DD". */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** UTC calendar-day key. All-day events are stored as UTC midnight and must
 *  land on the organizer's date regardless of the viewer's timezone. */
function utcDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The calendar day an event belongs to: its UTC date when all-day (never
 *  timezone-shifted), else the local day of its start instant. */
export function eventDayKey(event: CalendarEvent): string {
  const start = new Date(event.startsAt);
  return event.allDay ? utcDayKey(start) : localDayKey(start);
}

/** The 6×7 month grid (rows of week-day cells) covering `anchor`'s month. */
export function monthMatrix(anchor: Date): Date[][] {
  const first = startOfWeek(startOfMonth(anchor));
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) row.push(addDays(first, w * 7 + d));
    weeks.push(row);
  }
  return weeks;
}

/** The seven days of the week containing `anchor`. */
export function weekDays(anchor: Date): Date[] {
  const first = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/** Fetch window [from, to) for a view anchored at `anchor`. */
export function periodRange(
  view: CalendarView,
  anchor: Date,
): { from: Date; to: Date } {
  if (view === "month") {
    const from = startOfWeek(startOfMonth(anchor));
    return { from, to: addDays(from, 42) };
  }
  if (view === "week") {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 7) };
  }
  const from = startOfDay(anchor);
  return { from, to: addDays(from, 30) };
}

/** Step the anchor by one period in `dir` (-1 previous, +1 next). */
export function shiftAnchor(
  view: CalendarView,
  anchor: Date,
  dir: number,
): Date {
  if (view === "month") {
    return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
  }
  if (view === "week") return addDays(anchor, 7 * dir);
  return addDays(anchor, 30 * dir);
}

export function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return a.startsAt.localeCompare(b.startsAt);
}

/** Group events by their calendar-day key, each day's list sorted by start. */
export function eventsByDay(
  events: CalendarEvent[],
): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const key = eventDayKey(e);
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  }
  for (const list of map.values()) list.sort(byStart);
  return map;
}

/** Events sorted chronologically (for the agenda). */
export function sortedEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort(byStart);
}

/** Human time for a chip/row: "All day", a single time, or a start–end range. */
export function formatEventTime(event: CalendarEvent): string {
  if (event.allDay) return "All day";
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const start = new Date(event.startsAt).toLocaleTimeString([], opts);
  if (!event.endsAt) return start;
  return `${start} – ${new Date(event.endsAt).toLocaleTimeString([], opts)}`;
}

export const PARTSTAT_LABELS: Record<string, string> = {
  "needs-action": "No response",
  accepted: "Accepted",
  tentative: "Maybe",
  declined: "Declined",
};

// --- Event composer helpers (MAIL-31) --------------------------------------

/** Split an attendee field (commas / semicolons / whitespace) into addresses. */
export function parseAttendeeList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

/** A `datetime-local` value ("YYYY-MM-DDTHH:mm", local time) → ISO UTC. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A `date` input ("YYYY-MM-DD") → ISO at UTC midnight (all-day, never shifted). */
export function dateInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** True when the viewer organizes this event (their own attendee line is the
 *  organizer) — gates the Edit / Cancel actions, mirroring the API's check. */
export function isOrganizer(event: CalendarEvent): boolean {
  return (
    event.organizerAddr !== "" &&
    event.attendees.some((a) => a.isSelf && a.addr === event.organizerAddr)
  );
}

/** An ISO instant → the `datetime-local` value for the viewer's local zone. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
