import { eventAttendees, events, mailboxMembers } from "@mailbase/shared";
import { buildReplyIcs } from "@mailbase/shared/calendar";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { hasMailboxAccess } from "../lib/access";
import type { AppEnv } from "../lib/context";
import { getMailSender } from "../lib/mail-sender";
import { calendarEvent } from "../lib/serialize";

// Read-only calendar endpoints (Phase 7 / MAIL-27) plus the RSVP action
// (MAIL-29). Every access is scoped to the caller's mailbox memberships via the
// same innerJoin-on-mailbox_members pattern as messages/threads, so events never
// cross the multi-domain boundary.

// Collection routes mount at /api/calendar; the single-event + RSVP routes mount
// at /api/events/:id.
export const calendarRoutes = new Hono<AppEnv>();
export const eventRoutes = new Hono<AppEnv>();

// PARTSTAT values an attendee may RSVP with, lowercase as stored.
const RSVP_PARTSTATS = ["accepted", "tentative", "declined"] as const;
type RsvpPartstat = (typeof RSVP_PARTSTATS)[number];

/** Epoch seconds from an ISO-8601 string or a numeric (epoch-seconds) string. */
function parseInstant(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

async function attendeesByEvent(
  db: DrizzleD1Database,
  eventIds: string[],
): Promise<Map<string, (typeof eventAttendees.$inferSelect)[]>> {
  const map = new Map<string, (typeof eventAttendees.$inferSelect)[]>();
  if (eventIds.length === 0) return map;
  const rows = await db
    .select()
    .from(eventAttendees)
    .where(inArray(eventAttendees.eventId, eventIds))
    .all();
  for (const row of rows) {
    const list = map.get(row.eventId);
    if (list) list.push(row);
    else map.set(row.eventId, [row]);
  }
  return map;
}

// GET /api/calendar/events?from=&to=&mailboxId=
// Events overlapping [from, to] (either bound optional). With mailboxId, scope
// to that one mailbox (must be a membership); without it, every mailbox the
// caller belongs to — the unified "all inboxes" calendar.
calendarRoutes.get("/events", async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get("user").id;

  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  const from = parseInstant(fromRaw);
  const to = parseInstant(toRaw);
  if (fromRaw && from === null) {
    return c.json({ error: "from must be an ISO date or epoch seconds" }, 400);
  }
  if (toRaw && to === null) {
    return c.json({ error: "to must be an ISO date or epoch seconds" }, 400);
  }

  const mailboxId = c.req.query("mailboxId");
  if (mailboxId && !(await hasMailboxAccess(db, userId, mailboxId))) {
    return c.json({ error: "Mailbox not found" }, 404);
  }

  const conditions = [eq(mailboxMembers.userId, userId)];
  if (mailboxId) conditions.push(eq(events.mailboxId, mailboxId));
  // Overlap of [from, to] with the event span [startsAt, coalesce(endsAt,
  // startsAt)]: starts before the window ends, and ends after it begins.
  if (to !== null) conditions.push(sql`${events.startsAt} <= ${to}`);
  if (from !== null) {
    conditions.push(
      sql`coalesce(${events.endsAt}, ${events.startsAt}) >= ${from}`,
    );
  }

  const rows = await db
    .select({ event: events })
    .from(events)
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.mailboxId, events.mailboxId),
        eq(mailboxMembers.userId, userId),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(events.startsAt))
    .all();

  const eventList = rows.map((r) => r.event);
  const attendeeMap = await attendeesByEvent(
    db,
    eventList.map((e) => e.id),
  );
  return c.json({
    events: eventList.map((e) => calendarEvent(e, attendeeMap.get(e.id) ?? [])),
  });
});

// GET /api/events/:id — a single event with its attendees, only if the caller
// is a member of its mailbox.
eventRoutes.get("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get("user").id;

  const row = await db
    .select({ event: events })
    .from(events)
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.mailboxId, events.mailboxId),
        eq(mailboxMembers.userId, userId),
      ),
    )
    .where(eq(events.id, c.req.param("id")))
    .get();
  if (!row) return c.json({ error: "Event not found" }, 404);

  const attendees = await db
    .select()
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, row.event.id))
    .all();
  return c.json({ event: calendarEvent(row.event, attendees) });
});

// POST /api/events/:id/rsvp { partstat } — respond to an invite. Sends a
// standards-compliant METHOD:REPLY to the organizer and records the new status
// on the mailbox's own attendee line. Session + CSRF guarded by the global
// middleware; the event must be in a mailbox the caller belongs to and they must
// be an attendee of it.
eventRoutes.post("/:id/rsvp", async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get("user").id;

  const body = (await c.req.json().catch(() => null)) as {
    partstat?: unknown;
  } | null;
  const partstat =
    typeof body?.partstat === "string" ? body.partstat.toLowerCase() : "";
  if (!RSVP_PARTSTATS.includes(partstat as RsvpPartstat)) {
    return c.json(
      { error: "partstat must be accepted, tentative, or declined" },
      400,
    );
  }
  const stored = partstat as RsvpPartstat;

  const row = await db
    .select({ event: events })
    .from(events)
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.mailboxId, events.mailboxId),
        eq(mailboxMembers.userId, userId),
      ),
    )
    .where(eq(events.id, c.req.param("id")))
    .get();
  if (!row) return c.json({ error: "Event not found" }, 404);
  const event = row.event;

  if (!event.organizerAddr) {
    return c.json({ error: "This event has no organizer to reply to" }, 400);
  }

  // The mailbox's own attendee line (is_self) is what we echo back in the REPLY.
  const self = await db
    .select()
    .from(eventAttendees)
    .where(
      and(eq(eventAttendees.eventId, event.id), eq(eventAttendees.isSelf, true)),
    )
    .get();
  if (!self) {
    return c.json({ error: "You are not an attendee of this event" }, 403);
  }

  const ics = buildReplyIcs({
    uid: event.uid,
    sequence: event.sequence,
    organizerAddr: event.organizerAddr,
    attendeeAddr: self.addr,
    attendeeName: self.displayName || undefined,
    partstat: stored.toUpperCase() as "ACCEPTED" | "TENTATIVE" | "DECLINED",
    summary: event.summary || undefined,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    dtstamp: new Date(),
  });

  const verb =
    stored === "accepted"
      ? "Accepted"
      : stored === "declined"
        ? "Declined"
        : "Tentative";
  const title = event.summary || "(no title)";
  try {
    await getMailSender(c.env).send({
      from: self.displayName ? `${self.displayName} <${self.addr}>` : self.addr,
      to: [event.organizerAddr],
      subject: `${verb}: ${title}`,
      text: `${self.displayName || self.addr} responded "${verb}" to "${title}".`,
      attachments: [
        {
          filename: "invite.ics",
          contentType: "text/calendar; method=REPLY; charset=utf-8",
          content: ics,
        },
      ],
    });
  } catch (err) {
    console.error("RSVP reply send failed:", err);
    return c.json({ error: "The mail provider rejected the reply" }, 502);
  }

  await db
    .update(eventAttendees)
    .set({ partstat: stored })
    .where(
      and(
        eq(eventAttendees.eventId, event.id),
        eq(eventAttendees.addr, self.addr),
      ),
    );

  return c.json({ partstat: stored });
});
