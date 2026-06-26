import { ChevronLeft, ChevronRight, MapPin, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type CalendarEvent, listCalendarEvents } from "../api";
import { isAuthError } from "../App";
import {
  type CalendarView as CalView,
  eventsByDay,
  eventDayKey,
  formatEventTime,
  localDayKey,
  monthMatrix,
  PARTSTAT_LABELS,
  periodRange,
  sameDay,
  shiftAnchor,
  sortedEvents,
  startOfMonth,
  weekDays,
} from "../lib/calendar";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

const VIEWS: { id: CalView; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "week", label: "Week" },
  { id: "agenda", label: "Agenda" },
];

const WEEKDAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Per-mailbox calendar surface (MAIL-28). Read-only: it lists events from the
// MAIL-27 read API for the active mailbox (or every mailbox in the unified "all
// inboxes" view) and lets you open one for detail. RSVP lands in MAIL-29.
export function CalendarView({
  mailboxId,
  mailboxLabel,
  onAuthError,
}: {
  /** A specific mailbox id, or undefined for the unified "all inboxes" view. */
  mailboxId: string | undefined;
  mailboxLabel: string;
  onAuthError: () => void;
}) {
  const [view, setView] = useState<CalView>("month");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const loadSeq = useRef(0);

  const { from, to } = useMemo(() => periodRange(view, anchor), [view, anchor]);

  useEffect(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    listCalendarEvents(from.toISOString(), to.toISOString(), mailboxId)
      .then(({ events }) => {
        if (seq !== loadSeq.current) return;
        setEvents(events);
      })
      .catch((err) => {
        if (seq !== loadSeq.current) return;
        if (isAuthError(err)) onAuthError();
        else setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false);
      });
  }, [from, to, mailboxId, onAuthError]);

  const periodLabel = useMemo(() => {
    if (view === "month") {
      return anchor.toLocaleDateString([], { month: "long", year: "numeric" });
    }
    if (view === "week") {
      const days = weekDays(anchor);
      const first = days[0]!;
      const last = days[6]!;
      const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
      return `${first.toLocaleDateString([], opts)} – ${last.toLocaleDateString([], { ...opts, year: "numeric" })}`;
    }
    return "Next 30 days";
  }, [view, anchor]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-slate-950">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-100">
            {mailboxLabel}
          </h2>
          <p className="text-xs text-slate-400">{periodLabel}</p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAnchor(new Date())}
          >
            Today
          </Button>
          <button
            aria-label="Previous"
            className="rounded-md p-1.5 text-slate-300 hover:bg-slate-800"
            onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            aria-label="Next"
            className="rounded-md p-1.5 text-slate-300 hover:bg-slate-800"
            onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex rounded-md border border-slate-700 p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-slate-100",
                view === v.id && "bg-slate-800 text-slate-100",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p className="border-b border-red-900 bg-red-950/40 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {view === "month" && (
          <MonthGrid anchor={anchor} events={events} onSelect={setSelected} />
        )}
        {view === "week" && (
          <WeekColumns anchor={anchor} events={events} onSelect={setSelected} />
        )}
        {view === "agenda" && (
          <Agenda events={events} onSelect={setSelected} />
        )}
        {!loading && events.length === 0 && (
          <p className="mt-8 text-center text-sm text-slate-500">
            No events in this period.
          </p>
        )}
      </div>

      {selected && (
        <EventDetail event={selected} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}

function EventChip({
  event,
  onSelect,
}: {
  event: CalendarEvent;
  onSelect: (e: CalendarEvent) => void;
}) {
  const cancelled = event.status === "cancelled";
  return (
    <button
      onClick={() => onSelect(event)}
      title={event.summary}
      className={cn(
        "block w-full truncate rounded px-1.5 py-0.5 text-left text-xs",
        cancelled
          ? "text-slate-500 line-through hover:bg-slate-800"
          : "bg-sky-950/60 text-sky-200 hover:bg-sky-900/70",
      )}
    >
      {!event.allDay && (
        <span className="mr-1 tabular-nums text-[10px] opacity-80">
          {new Date(event.startsAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      )}
      {event.summary || "(no title)"}
    </button>
  );
}

function MonthGrid({
  anchor,
  events,
  onSelect,
}: {
  anchor: Date;
  events: CalendarEvent[];
  onSelect: (e: CalendarEvent) => void;
}) {
  const weeks = useMemo(() => monthMatrix(anchor), [anchor]);
  const byDay = useMemo(() => eventsByDay(events), [events]);
  const month = startOfMonth(anchor).getMonth();
  const today = new Date();

  return (
    <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-slate-800">
      {WEEKDAY_HEADERS.map((d) => (
        <div
          key={d}
          className="border-b border-slate-800 bg-slate-900 px-2 py-1.5 text-center text-xs font-medium text-slate-400"
        >
          {d}
        </div>
      ))}
      {weeks.flat().map((day) => {
        const dayEvents = byDay.get(localDayKey(day)) ?? [];
        const inMonth = day.getMonth() === month;
        return (
          <div
            key={day.toISOString()}
            className={cn(
              "min-h-24 border-b border-r border-slate-800 p-1",
              !inMonth && "bg-slate-900/40",
            )}
          >
            <div
              className={cn(
                "mb-1 px-1 text-right text-xs",
                inMonth ? "text-slate-400" : "text-slate-600",
                sameDay(day, today) &&
                  "font-semibold text-sky-300",
              )}
            >
              {day.getDate()}
            </div>
            <div className="space-y-0.5">
              {dayEvents.slice(0, 3).map((e) => (
                <EventChip key={e.id} event={e} onSelect={onSelect} />
              ))}
              {dayEvents.length > 3 && (
                <p className="px-1 text-[10px] text-slate-500">
                  +{dayEvents.length - 3} more
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WeekColumns({
  anchor,
  events,
  onSelect,
}: {
  anchor: Date;
  events: CalendarEvent[];
  onSelect: (e: CalendarEvent) => void;
}) {
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const byDay = useMemo(() => eventsByDay(events), [events]);
  const today = new Date();

  return (
    <div className="grid grid-cols-7 gap-2">
      {days.map((day) => {
        const dayEvents = byDay.get(localDayKey(day)) ?? [];
        return (
          <div
            key={day.toISOString()}
            className="rounded-lg border border-slate-800 p-2"
          >
            <div
              className={cn(
                "mb-2 text-xs font-medium",
                sameDay(day, today) ? "text-sky-300" : "text-slate-400",
              )}
            >
              {day.toLocaleDateString([], { weekday: "short", day: "numeric" })}
            </div>
            <div className="space-y-1">
              {dayEvents.map((e) => (
                <EventChip key={e.id} event={e} onSelect={onSelect} />
              ))}
              {dayEvents.length === 0 && (
                <p className="text-[10px] text-slate-600">—</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Agenda({
  events,
  onSelect,
}: {
  events: CalendarEvent[];
  onSelect: (e: CalendarEvent) => void;
}) {
  const ordered = useMemo(() => sortedEvents(events), [events]);
  let lastDay = "";

  return (
    <div className="mx-auto max-w-2xl space-y-1">
      {ordered.map((e) => {
        const dayKey = eventDayKey(e);
        const showDay = dayKey !== lastDay;
        lastDay = dayKey;
        return (
          <div key={e.id}>
            {showDay && (
              <h3 className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {new Date(e.startsAt).toLocaleDateString([], {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </h3>
            )}
            <button
              onClick={() => onSelect(e)}
              className="flex w-full items-center gap-3 rounded-md border border-slate-800 px-3 py-2 text-left hover:bg-slate-900"
            >
              <span className="w-28 shrink-0 text-xs text-slate-400">
                {formatEventTime(e)}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  e.status === "cancelled"
                    ? "text-slate-500 line-through"
                    : "text-slate-100",
                )}
              >
                {e.summary || "(no title)"}
              </span>
              {e.rrule && (
                <span className="shrink-0 text-[10px] text-slate-500">
                  recurring
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function EventDetail({
  event,
  onClose,
}: {
  event: CalendarEvent;
  onClose: () => void;
}) {
  const when = event.allDay
    ? new Date(event.startsAt).toLocaleDateString([], {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : `${new Date(event.startsAt).toLocaleString()}${
        event.endsAt
          ? ` – ${new Date(event.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : ""
      }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-100">
            {event.summary || "(no title)"}
          </h3>
          <button
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {event.status === "cancelled" && (
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-red-400">
            Cancelled
          </p>
        )}

        <p className="mt-2 text-sm text-slate-300">{when}</p>
        {event.allDay && <p className="text-xs text-slate-500">All day</p>}
        {event.tzid && !event.allDay && (
          <p className="text-xs text-slate-500">{event.tzid}</p>
        )}
        {event.rrule && (
          <p className="mt-1 text-xs text-slate-500">
            Recurring (showing this occurrence)
          </p>
        )}

        {event.location && (
          <p className="mt-3 flex items-center gap-2 text-sm text-slate-300">
            <MapPin className="h-4 w-4 shrink-0 text-slate-500" />
            <span className="min-w-0 break-words">{event.location}</span>
          </p>
        )}
        {event.organizerAddr && (
          <p className="mt-1 text-xs text-slate-400">
            Organizer: {event.organizerAddr}
          </p>
        )}

        {event.attendees.length > 0 && (
          <div className="mt-3">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
              <Users className="h-3.5 w-3.5" /> Attendees
            </p>
            <ul className="mt-1 space-y-0.5">
              {event.attendees.map((a) => (
                <li key={a.addr} className="flex justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-slate-300">
                    {a.displayName || a.addr}
                    {a.isSelf && (
                      <span className="ml-1 text-xs text-slate-500">(you)</span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {PARTSTAT_LABELS[a.partstat] ?? a.partstat}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {event.description && (
          <p className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-300">
            {event.description}
          </p>
        )}
      </div>
    </div>
  );
}
