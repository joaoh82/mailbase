import { eventAttendees, events, mailboxMembers } from "@mailbase/shared";
import { buildReplyIcs } from "@mailbase/shared/calendar";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { hasMailboxAccess } from "../lib/access";
import { getMailSender } from "../lib/mail-sender";
import { calendarEvent } from "../lib/serialize";
import { type ServiceContext, ServiceError } from "./context";

// Calendar reads + RSVP (Phase 7), shared by the webmail routes and the agent
// REST/MCP surface. Every access is scoped to the caller's mailbox memberships.
// RSVP sends a METHOD:REPLY but (as in the webmail) stores no Sent copy.

// PARTSTAT values an attendee may RSVP with, lowercase as stored.
export const RSVP_PARTSTATS = ["accepted", "tentative", "declined"] as const;
export type RsvpPartstat = (typeof RSVP_PARTSTATS)[number];

/** Epoch seconds from an ISO-8601 string or a numeric (epoch-seconds) string. */
export function parseInstant(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export async function attendeesByEvent(
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

/**
 * Events overlapping [from, to] (either bound optional). With mailboxId, that
 * one mailbox (must be a membership); without it, every mailbox of the caller.
 */
export async function listEvents(
  ctx: ServiceContext,
  input: { from?: string; to?: string; mailboxId?: string },
) {
  const { db, userId } = ctx;
  const from = parseInstant(input.from);
  const to = parseInstant(input.to);
  if (input.from && from === null) {
    throw new ServiceError(400, "from must be an ISO date or epoch seconds");
  }
  if (input.to && to === null) {
    throw new ServiceError(400, "to must be an ISO date or epoch seconds");
  }
  const mailboxId = input.mailboxId;
  if (mailboxId && !(await hasMailboxAccess(db, userId, mailboxId))) {
    throw new ServiceError(404, "Mailbox not found");
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
  return eventList.map((e) => calendarEvent(e, attendeeMap.get(e.id) ?? []));
}

async function requireEvent(ctx: ServiceContext, eventId: string) {
  const row = await ctx.db
    .select({ event: events })
    .from(events)
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.mailboxId, events.mailboxId),
        eq(mailboxMembers.userId, ctx.userId),
      ),
    )
    .where(eq(events.id, eventId))
    .get();
  if (!row) throw new ServiceError(404, "Event not found");
  return row.event;
}

/** A single event with its attendees, only for members of its mailbox. */
export async function getEvent(ctx: ServiceContext, eventId: string) {
  const event = await requireEvent(ctx, eventId);
  const attendees = await ctx.db
    .select()
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, event.id))
    .all();
  return calendarEvent(event, attendees);
}

/**
 * Respond to an invite: send a METHOD:REPLY to the organizer and record the
 * new status on the mailbox's own attendee line.
 */
export async function rsvpEvent(
  ctx: ServiceContext,
  eventId: string,
  partstatInput: unknown,
): Promise<RsvpPartstat> {
  const partstat =
    typeof partstatInput === "string" ? partstatInput.toLowerCase() : "";
  if (!RSVP_PARTSTATS.includes(partstat as RsvpPartstat)) {
    throw new ServiceError(
      400,
      "partstat must be accepted, tentative, or declined",
    );
  }
  const stored = partstat as RsvpPartstat;
  const event = await requireEvent(ctx, eventId);
  if (!event.organizerAddr) {
    throw new ServiceError(400, "This event has no organizer to reply to");
  }

  // The mailbox's own attendee line (is_self) is what we echo back.
  const self = await ctx.db
    .select()
    .from(eventAttendees)
    .where(
      and(eq(eventAttendees.eventId, event.id), eq(eventAttendees.isSelf, true)),
    )
    .get();
  if (!self) {
    throw new ServiceError(403, "You are not an attendee of this event");
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
    await getMailSender(ctx.env).send({
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
    throw new ServiceError(502, "The mail provider rejected the reply");
  }

  await ctx.db
    .update(eventAttendees)
    .set({ partstat: stored })
    .where(
      and(
        eq(eventAttendees.eventId, event.id),
        eq(eventAttendees.addr, self.addr),
      ),
    );
  return stored;
}
