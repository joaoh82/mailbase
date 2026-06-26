import {
  addresses,
  domains,
  eventAttendees,
  events,
  mailboxes,
  mailboxMembers,
} from "@mailbase/shared";
import {
  buildEventIcs,
  buildReplyIcs,
  type EventIcsAttendee,
} from "@mailbase/shared/calendar";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { hasMailboxAccess } from "../lib/access";
import type { AppEnv } from "../lib/context";
import { getMailSender } from "../lib/mail-sender";
import { calendarEvent } from "../lib/serialize";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

interface ParsedAttendee {
  addr: string;
  displayName: string;
}

// Accept attendees as ["a@b.com"] or [{ addr, displayName }]; null on any
// invalid address.
function parseAttendees(value: unknown): ParsedAttendee[] | null {
  if (!Array.isArray(value)) return null;
  const out: ParsedAttendee[] = [];
  for (const entry of value) {
    const raw =
      typeof entry === "string"
        ? entry
        : typeof (entry as { addr?: unknown })?.addr === "string"
          ? (entry as { addr: string }).addr
          : "";
    const addr = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) return null;
    const displayName =
      typeof (entry as { displayName?: unknown })?.displayName === "string"
        ? (entry as { displayName: string }).displayName
        : "";
    out.push({ addr, displayName });
  }
  return out;
}

/** The address a mailbox organizes from (its first address), plus the From name. */
async function resolveOrganizer(
  db: DrizzleD1Database,
  mailboxId: string,
): Promise<{ addr: string; name: string; domain: string } | null> {
  const row = await db
    .select({
      localPart: addresses.localPart,
      domain: domains.name,
      mailboxName: mailboxes.displayName,
    })
    .from(addresses)
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .innerJoin(mailboxes, eq(mailboxes.id, addresses.mailboxId))
    .where(eq(addresses.mailboxId, mailboxId))
    .orderBy(asc(addresses.localPart))
    .get();
  if (!row) return null;
  return {
    addr: `${row.localPart}@${row.domain}`,
    name: row.mailboxName,
    domain: row.domain,
  };
}

/** An event by id, only if the caller is a member of its mailbox. */
async function loadAccessibleEvent(
  db: DrizzleD1Database,
  userId: string,
  id: string,
): Promise<typeof events.$inferSelect | undefined> {
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
    .where(eq(events.id, id))
    .get();
  return row?.event;
}

/** True when this mailbox is the event's organizer (only the organizer may
 *  edit/cancel and re-send). */
async function isSelfOrganizer(
  db: DrizzleD1Database,
  event: typeof events.$inferSelect,
): Promise<boolean> {
  if (!event.organizerAddr) return false;
  const row = await db
    .select({ addr: eventAttendees.addr })
    .from(eventAttendees)
    .where(
      and(
        eq(eventAttendees.eventId, event.id),
        eq(eventAttendees.isSelf, true),
        eq(eventAttendees.addr, event.organizerAddr),
      ),
    )
    .get();
  return row !== undefined;
}

/** The organizer's display name, taken from the stored self attendee row. */
async function organizerDisplayName(
  db: DrizzleD1Database,
  event: typeof events.$inferSelect,
  fallback: string,
): Promise<string> {
  const row = await db
    .select({ displayName: eventAttendees.displayName })
    .from(eventAttendees)
    .where(
      and(eq(eventAttendees.eventId, event.id), eq(eventAttendees.isSelf, true)),
    )
    .get();
  return row?.displayName || fallback;
}

/** The non-self attendees (the invitees) of an event. */
async function loadInvitees(
  db: DrizzleD1Database,
  eventId: string,
): Promise<EventIcsAttendee[]> {
  const rows = await db
    .select()
    .from(eventAttendees)
    .where(
      and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.isSelf, false)),
    )
    .all();
  return rows.map((r) => ({
    addr: r.addr,
    displayName: r.displayName || undefined,
  }));
}

// Build the REQUEST/CANCEL iCalendar and send it to the invitees via the
// MailSender (the spike's .ics attachment recipe — Resend can't do an inline
// part). Returns the raw .ics so the caller can store it. Throws on send failure.
async function sendInvite(
  env: Env,
  method: "REQUEST" | "CANCEL",
  event: {
    uid: string;
    sequence: number;
    organizerAddr: string;
    organizerName: string;
    summary: string;
    description: string;
    location: string;
    startsAt: Date;
    endsAt: Date | null;
    allDay: boolean;
  },
  invitees: EventIcsAttendee[],
): Promise<string> {
  const ics = buildEventIcs({
    method,
    uid: event.uid,
    sequence: event.sequence,
    organizerAddr: event.organizerAddr,
    organizerName: event.organizerName || undefined,
    summary: event.summary || undefined,
    description: event.description || undefined,
    location: event.location || undefined,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    attendees: invitees,
    dtstamp: new Date(),
  });
  const title = event.summary || "(no title)";
  const subject = method === "CANCEL" ? `Cancelled: ${title}` : `Invitation: ${title}`;
  await getMailSender(env).send({
    from: event.organizerName
      ? `${event.organizerName} <${event.organizerAddr}>`
      : event.organizerAddr,
    to: invitees.map((a) => a.addr),
    subject,
    text: subject,
    attachments: [
      {
        filename: "invite.ics",
        contentType: `text/calendar; method=${method}; charset=utf-8`,
        content: ics,
      },
    ],
  });
  return ics;
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

// POST /api/calendar/events — create an invite the caller organizes from one of
// their mailboxes, send a METHOD:REQUEST to the attendees, and persist it.
calendarRoutes.post("/events", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  const mailboxId = typeof body?.mailboxId === "string" ? body.mailboxId : "";
  const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
  const description =
    typeof body?.description === "string" ? body.description : "";
  const location = typeof body?.location === "string" ? body.location : "";
  const tzid = typeof body?.tzid === "string" ? body.tzid : "";
  const allDay = body?.allDay === true;
  const startsAt = parseDate(body?.startsAt);
  const endsAt = body?.endsAt == null ? null : parseDate(body.endsAt);
  const attendees = parseAttendees(body?.attendees);

  if (!mailboxId) return c.json({ error: "mailboxId is required" }, 400);
  if (!summary) return c.json({ error: "summary is required" }, 400);
  if (!startsAt) return c.json({ error: "startsAt must be a valid date" }, 400);
  if (body?.endsAt != null && !endsAt) {
    return c.json({ error: "endsAt must be a valid date" }, 400);
  }
  if (attendees === null) {
    return c.json({ error: "attendees must be valid email addresses" }, 400);
  }
  if (attendees.length === 0) {
    return c.json({ error: "at least one attendee is required" }, 400);
  }

  if (!(await hasMailboxAccess(db, user.id, mailboxId))) {
    return c.json({ error: "Mailbox not found" }, 404);
  }
  const organizer = await resolveOrganizer(db, mailboxId);
  if (!organizer) {
    return c.json({ error: "This mailbox has no address to organize from" }, 400);
  }
  const organizerName = organizer.name || user.displayName;

  const eventId = crypto.randomUUID();
  const uid = `${eventId}@${organizer.domain}`;
  const invitees: EventIcsAttendee[] = attendees.map((a) => ({
    addr: a.addr,
    displayName: a.displayName || undefined,
  }));

  let ics: string;
  try {
    ics = await sendInvite(
      c.env,
      "REQUEST",
      {
        uid,
        sequence: 0,
        organizerAddr: organizer.addr,
        organizerName,
        summary,
        description,
        location,
        startsAt,
        endsAt,
        allDay,
      },
      invitees,
    );
  } catch (err) {
    console.error("Invite send failed:", err);
    return c.json({ error: "The mail provider rejected the invite" }, 502);
  }

  const calendarKey = `calendar/${organizer.domain}/${mailboxId}/${eventId}.ics`;
  await c.env.MAIL_BUCKET.put(calendarKey, ics, {
    httpMetadata: { contentType: "text/calendar" },
  });

  await db.batch([
    db.insert(events).values({
      id: eventId,
      mailboxId,
      uid,
      sequence: 0,
      organizerAddr: organizer.addr,
      summary,
      description,
      location,
      startsAt,
      endsAt,
      allDay,
      tzid,
      status: "confirmed",
      method: "REQUEST",
      rawIcsR2Key: calendarKey,
    }),
    db.insert(eventAttendees).values([
      {
        eventId,
        addr: organizer.addr,
        displayName: organizerName,
        partstat: "accepted",
        role: "CHAIR",
        isSelf: true,
      },
      ...attendees.map((a) => ({
        eventId,
        addr: a.addr,
        displayName: a.displayName,
        partstat: "needs-action" as const,
        role: "REQ-PARTICIPANT",
        isSelf: false,
      })),
    ]),
  ]);

  const created = (await loadAccessibleEvent(db, user.id, eventId))!;
  const at = await db
    .select()
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, eventId))
    .all();
  return c.json({ event: calendarEvent(created, at) }, 201);
});

// PATCH /api/calendar/events/:id — edit an event we organize: bump SEQUENCE and
// re-send the REQUEST to its attendees.
calendarRoutes.patch("/events/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const event = await loadAccessibleEvent(db, user.id, c.req.param("id"));
  if (!event) return c.json({ error: "Event not found" }, 404);
  if (!(await isSelfOrganizer(db, event))) {
    return c.json({ error: "Only the organizer can edit this event" }, 403);
  }

  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  const summary =
    typeof body?.summary === "string" ? body.summary.trim() : event.summary;
  const description =
    typeof body?.description === "string" ? body.description : event.description;
  const location =
    typeof body?.location === "string" ? body.location : event.location;
  const tzid = typeof body?.tzid === "string" ? body.tzid : event.tzid;
  const allDay =
    typeof body?.allDay === "boolean" ? body.allDay : event.allDay;
  const startsAt =
    body?.startsAt === undefined ? event.startsAt : parseDate(body.startsAt);
  const endsAt =
    body?.endsAt === undefined
      ? event.endsAt
      : body.endsAt == null
        ? null
        : parseDate(body.endsAt);
  if (!startsAt) return c.json({ error: "startsAt must be a valid date" }, 400);
  if (body?.endsAt != null && body?.endsAt !== undefined && !endsAt) {
    return c.json({ error: "endsAt must be a valid date" }, 400);
  }

  let invitees: EventIcsAttendee[];
  if (body?.attendees === undefined) {
    invitees = await loadInvitees(db, event.id);
  } else {
    const parsed = parseAttendees(body.attendees);
    if (parsed === null) {
      return c.json({ error: "attendees must be valid email addresses" }, 400);
    }
    if (parsed.length === 0) {
      return c.json({ error: "at least one attendee is required" }, 400);
    }
    invitees = parsed.map((a) => ({
      addr: a.addr,
      displayName: a.displayName || undefined,
    }));
  }

  const organizerName = await organizerDisplayName(db, event, user.displayName);
  const sequence = event.sequence + 1;
  let ics: string;
  try {
    ics = await sendInvite(
      c.env,
      "REQUEST",
      {
        uid: event.uid,
        sequence,
        organizerAddr: event.organizerAddr,
        organizerName,
        summary,
        description,
        location,
        startsAt,
        endsAt,
        allDay,
      },
      invitees,
    );
  } catch (err) {
    console.error("Invite update send failed:", err);
    return c.json({ error: "The mail provider rejected the update" }, 502);
  }

  await c.env.MAIL_BUCKET.put(event.rawIcsR2Key || `calendar/${event.mailboxId}/${event.id}.ics`, ics, {
    httpMetadata: { contentType: "text/calendar" },
  });

  const attendeeRows = [
    {
      eventId: event.id,
      addr: event.organizerAddr,
      displayName: organizerName,
      partstat: "accepted" as const,
      role: "CHAIR",
      isSelf: true,
    },
    ...invitees.map((a) => ({
      eventId: event.id,
      addr: a.addr,
      displayName: a.displayName ?? "",
      partstat: "needs-action" as const,
      role: "REQ-PARTICIPANT",
      isSelf: false,
    })),
  ];
  await db.batch([
    db
      .update(events)
      .set({
        summary,
        description,
        location,
        tzid,
        allDay,
        startsAt,
        endsAt,
        sequence,
        status: "confirmed",
        method: "REQUEST",
        updatedAt: new Date(),
      })
      .where(eq(events.id, event.id)),
    db.delete(eventAttendees).where(eq(eventAttendees.eventId, event.id)),
    db.insert(eventAttendees).values(attendeeRows),
  ]);

  const updated = (await loadAccessibleEvent(db, user.id, event.id))!;
  const at = await db
    .select()
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, event.id))
    .all();
  return c.json({ event: calendarEvent(updated, at) });
});

// DELETE /api/calendar/events/:id — cancel an event we organize: send a
// METHOD:CANCEL to its attendees and mark it cancelled.
calendarRoutes.delete("/events/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const event = await loadAccessibleEvent(db, user.id, c.req.param("id"));
  if (!event) return c.json({ error: "Event not found" }, 404);
  if (!(await isSelfOrganizer(db, event))) {
    return c.json({ error: "Only the organizer can cancel this event" }, 403);
  }

  const organizerName = await organizerDisplayName(db, event, user.displayName);
  const invitees = await loadInvitees(db, event.id);
  const sequence = event.sequence + 1;
  try {
    await sendInvite(
      c.env,
      "CANCEL",
      {
        uid: event.uid,
        sequence,
        organizerAddr: event.organizerAddr,
        organizerName,
        summary: event.summary,
        description: event.description,
        location: event.location,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
      },
      invitees,
    );
  } catch (err) {
    console.error("Invite cancel send failed:", err);
    return c.json({ error: "The mail provider rejected the cancellation" }, 502);
  }

  await db
    .update(events)
    .set({
      status: "cancelled",
      sequence,
      method: "CANCEL",
      updatedAt: new Date(),
    })
    .where(eq(events.id, event.id));

  return c.json({ ok: true });
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
