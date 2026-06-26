import { X } from "lucide-react";
import { useState } from "react";
import { createCalendarEvent, type Mailbox } from "../api";
import {
  dateInputToIso,
  isEmail,
  isoToLocalInput,
  localInputToIso,
  parseAttendeeList,
} from "../lib/calendar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function roundedNextHour(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function todayDate(): string {
  return isoToLocalInput(new Date().toISOString()).slice(0, 10);
}

// "New event" composer (MAIL-31). Organize an invite from one of your mailboxes
// and send a REQUEST to the attendees via POST /api/calendar/events. Lives in
// the lazy calendar chunk, so it stays out of the initial bundle.
export function NewEventModal({
  mailboxes,
  defaultMailboxId,
  onClose,
  onCreated,
}: {
  mailboxes: Mailbox[];
  defaultMailboxId?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [mailboxId, setMailboxId] = useState(
    defaultMailboxId ?? mailboxes[0]?.id ?? "",
  );
  const [summary, setSummary] = useState("");
  const [allDay, setAllDay] = useState(false);
  const start = roundedNextHour();
  const [startLocal, setStartLocal] = useState(() =>
    isoToLocalInput(start.toISOString()),
  );
  const [endLocal, setEndLocal] = useState(() =>
    isoToLocalInput(new Date(start.getTime() + 3_600_000).toISOString()),
  );
  const [startDate, setStartDate] = useState(todayDate);
  const [endDate, setEndDate] = useState(todayDate);
  const [location, setLocation] = useState("");
  const [attendeesText, setAttendeesText] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const trimmedSummary = summary.trim();
    const attendees = parseAttendeeList(attendeesText);

    if (!mailboxId) return setError("Choose a mailbox to organize from.");
    if (!trimmedSummary) return setError("Add a title.");
    if (attendees.length === 0) return setError("Add at least one attendee.");
    const bad = attendees.find((a) => !isEmail(a));
    if (bad) return setError(`"${bad}" is not a valid email address.`);

    let startsAt: string | null;
    let endsAt: string | null;
    if (allDay) {
      startsAt = dateInputToIso(startDate);
      endsAt = endDate ? dateInputToIso(endDate) : null;
      if (!startsAt) return setError("Choose a start date.");
    } else {
      startsAt = localInputToIso(startLocal);
      endsAt = endLocal ? localInputToIso(endLocal) : null;
      if (!startsAt) return setError("Choose a start time.");
    }

    setSubmitting(true);
    try {
      await createCalendarEvent({
        mailboxId,
        summary: trimmedSummary,
        startsAt,
        endsAt,
        allDay,
        tzid: allDay
          ? ""
          : Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        location: location.trim(),
        description: description.trim(),
        attendees,
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the event.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border border-slate-700 bg-slate-900">
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">New event</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {mailboxes.length > 1 && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">
                Organize as
              </span>
              <select
                className="h-9 w-full rounded-md border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100"
                value={mailboxId}
                onChange={(e) => setMailboxId(e.target.value)}
              >
                {mailboxes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.address}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">
              Title
            </span>
            <Input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Design review"
              autoFocus
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
            />
            All day
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">
                Start
              </span>
              {allDay ? (
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              ) : (
                <Input
                  type="datetime-local"
                  value={startLocal}
                  onChange={(e) => setStartLocal(e.target.value)}
                />
              )}
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">
                End
              </span>
              {allDay ? (
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              ) : (
                <Input
                  type="datetime-local"
                  value={endLocal}
                  onChange={(e) => setEndLocal(e.target.value)}
                />
              )}
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">
              Location
            </span>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Room B, or a video link"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">
              Attendees
            </span>
            <textarea
              className="min-h-16 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              value={attendeesText}
              onChange={(e) => setAttendeesText(e.target.value)}
              placeholder="alice@example.com, bob@example.com"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">
              Description
            </span>
            <textarea
              className="min-h-20 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-800 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={submitting}>
            {submitting ? "Sending…" : "Send invite"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
