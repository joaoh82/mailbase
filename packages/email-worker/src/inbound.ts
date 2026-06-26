import {
  addresses,
  attachments,
  domains,
  eventAttendees,
  events,
  messages,
  normalizeSubject,
  threads,
} from "@mailbase/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { type ParsedCalendar, parseInbound } from "./parse";

const SNIPPET_LENGTH = 160;

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const recipient = message.to.toLowerCase();
  const at = recipient.lastIndexOf("@");
  if (at < 1 || at === recipient.length - 1) {
    message.setReject("Invalid recipient address");
    return;
  }
  const localPart = recipient.slice(0, at);
  const domainName = recipient.slice(at + 1);

  const db = drizzle(env.DB);

  const domain = await db
    .select()
    .from(domains)
    .where(eq(domains.name, domainName))
    .get();
  if (!domain) {
    message.setReject(`This server does not accept mail for ${domainName}`);
    return;
  }

  const address = await db
    .select()
    .from(addresses)
    .where(
      and(
        eq(addresses.domainId, domain.id),
        eq(addresses.localPart, localPart),
      ),
    )
    .get();

  let mailboxId: string;
  if (address) {
    mailboxId = address.mailboxId;
  } else if (domain.rejectUnknown) {
    message.setReject(`No such recipient: ${recipient}`);
    return;
  } else if (domain.catchAllMailboxId) {
    mailboxId = domain.catchAllMailboxId;
  } else {
    message.setReject(`No such recipient: ${recipient}`);
    return;
  }

  // Buffer the raw message once: it is both the immutable R2 blob and the
  // parser input.
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await parseInbound(rawBuffer, message);

  // One copy per mailbox: a message sent to several aliases of the same
  // mailbox is delivered once per envelope recipient, and a sender may retry
  // after a delivery already succeeded. Accept duplicates without storing.
  if (parsed.messageIdHeader !== "") {
    const existing = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, mailboxId),
          eq(messages.messageIdHeader, parsed.messageIdHeader),
        ),
      )
      .get();
    if (existing) {
      console.log(
        `Duplicate delivery of <${parsed.messageIdHeader}> to mailbox ${mailboxId}; already stored as ${existing.id}`,
      );
      return;
    }
  }

  const messageId = crypto.randomUUID();
  const rawKey = `${domain.name}/${mailboxId}/${messageId}.eml`;

  // From here on, any thrown error temp-fails the message at the SMTP layer
  // so the sender retries — mail must never be lost. R2 goes first because
  // the raw blob is the source of truth; a retry after a partial failure gets
  // a fresh messageId, and an orphaned blob is harmless.
  await env.MAIL_BUCKET.put(rawKey, rawBuffer, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  const attachmentRows: (typeof attachments.$inferInsert)[] = [];
  for (const att of parsed.attachments) {
    const attachmentId = crypto.randomUUID();
    const r2Key = `attachments/${domain.name}/${mailboxId}/${messageId}/${attachmentId}`;
    const size =
      typeof att.content === "string"
        ? new TextEncoder().encode(att.content).byteLength
        : att.content.byteLength;
    await env.MAIL_BUCKET.put(r2Key, att.content, {
      httpMetadata: { contentType: att.mimeType },
    });
    attachmentRows.push({
      id: attachmentId,
      messageId,
      filename: att.filename,
      mimeType: att.mimeType,
      size,
      r2Key,
    });
  }

  const { norm: subjectNorm, isReply } = normalizeSubject(parsed.subject);
  const threadId = await resolveThreadId(
    db,
    mailboxId,
    subjectNorm,
    isReply,
    parsed.referenceIds,
  );

  const statements: BatchItem<"sqlite">[] = [];
  if (threadId) {
    statements.push(
      db
        .update(threads)
        .set({
          lastMessageAt: sql`max(${threads.lastMessageAt}, ${Math.floor(parsed.date.getTime() / 1000)})`,
          messageCount: sql`${threads.messageCount} + 1`,
        })
        .where(eq(threads.id, threadId)),
    );
  }
  const finalThreadId = threadId ?? crypto.randomUUID();
  if (!threadId) {
    statements.push(
      db.insert(threads).values({
        id: finalThreadId,
        mailboxId,
        subjectNorm,
        lastMessageAt: parsed.date,
        messageCount: 1,
      }),
    );
  }

  // The messages_fts triggers from migration 0001 keep the search index in
  // sync with this insert.
  statements.push(
    db.insert(messages).values({
      id: messageId,
      mailboxId,
      r2Key: rawKey,
      threadId: finalThreadId,
      direction: "inbound",
      fromAddr: parsed.fromAddr,
      toAddrs: parsed.toAddrs,
      subject: parsed.subject,
      snippet: parsed.bodyText.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH),
      bodyText: parsed.bodyText,
      hasAttachments: attachmentRows.length > 0,
      size: rawBuffer.byteLength,
      date: parsed.date,
      messageIdHeader: parsed.messageIdHeader,
    }),
  );

  if (attachmentRows.length > 0) {
    statements.push(db.insert(attachments).values(attachmentRows));
  }

  // D1 batches run atomically: the message, its attachments, and the thread
  // update land together or not at all.
  try {
    await db.batch(
      statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
    );
  } catch (error) {
    // Concurrent deliveries to aliases of one mailbox race past the
    // pre-insert check above; the unique index is the backstop. The other
    // delivery already stored the message, so accept this one without it.
    if (isDuplicateMessageError(error)) {
      console.log(
        `Concurrent duplicate delivery of <${parsed.messageIdHeader}> to mailbox ${mailboxId}; keeping the other copy`,
      );
      return;
    }
    throw error;
  }

  // Meeting invite? Derive the calendar event from it. This is best-effort and
  // runs only after the message is safely stored: the message must never be lost
  // over a calendar problem, so any failure here is logged, not thrown.
  if (parsed.calendar) {
    try {
      await storeCalendarEvent(db, env, {
        domainName: domain.name,
        mailboxId,
        messageId,
        calendar: parsed.calendar,
      });
    } catch (error) {
      console.warn(
        `Failed to store calendar event for message ${messageId}:`,
        error,
      );
    }
  }
}

// Upsert a calendar event from an inbound invite, keyed by (mailbox_id, uid).
// REQUEST/CANCEL insert when new and replace when the incoming SEQUENCE is at
// least the stored one (stale re-sends are ignored); a CANCEL flips status to
// 'cancelled' (the parser normalizes that). A REPLY only updates the replying
// attendee's PARTSTAT on an event we already hold — it never creates or replaces
// one, since its VEVENT carries only the replier. The raw .ics is stored in R2
// as the event's source of truth.
async function storeCalendarEvent(
  db: DrizzleD1Database,
  env: Env,
  args: {
    domainName: string;
    mailboxId: string;
    messageId: string;
    calendar: ParsedCalendar;
  },
): Promise<void> {
  const { domainName, mailboxId, messageId } = args;
  const { event, rawText } = args.calendar;
  // Without a UID we can't reconcile updates/cancellations — skip.
  if (event.uid === "") return;

  const calendarKey = `calendar/${domainName}/${mailboxId}/${messageId}.ics`;
  await env.MAIL_BUCKET.put(calendarKey, rawText, {
    httpMetadata: { contentType: "text/calendar" },
  });

  const existing = await db
    .select()
    .from(events)
    .where(and(eq(events.mailboxId, mailboxId), eq(events.uid, event.uid)))
    .get();

  if (event.method === "REPLY") {
    const replier = event.attendees[0];
    if (!existing || !replier) return;
    await db
      .update(eventAttendees)
      .set({ partstat: replier.partstat })
      .where(
        and(
          eq(eventAttendees.eventId, existing.id),
          eq(eventAttendees.addr, replier.addr),
        ),
      );
    return;
  }

  // Ignore a re-sent invite that is older than what we already have.
  if (existing && event.sequence < existing.sequence) return;

  // Mark the mailbox's own ATTENDEE line: any of this mailbox's addresses.
  const mailboxAddrs = await db
    .select({ localPart: addresses.localPart })
    .from(addresses)
    .where(eq(addresses.mailboxId, mailboxId))
    .all();
  const selfSet = new Set(
    mailboxAddrs.map((a) => `${a.localPart}@${domainName}`.toLowerCase()),
  );

  const eventId = existing?.id ?? crypto.randomUUID();
  const attendeeRows = event.attendees.map((a) => ({
    eventId,
    addr: a.addr,
    displayName: a.displayName,
    partstat: a.partstat,
    role: a.role,
    isSelf: selfSet.has(a.addr),
  }));

  const values = {
    mailboxId,
    messageId,
    uid: event.uid,
    sequence: event.sequence,
    organizerAddr: event.organizerAddr,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    tzid: event.tzid,
    status: event.status,
    rrule: event.rrule,
    method: event.method,
    rawIcsR2Key: calendarKey,
    updatedAt: new Date(),
  };

  const statements: BatchItem<"sqlite">[] = existing
    ? [
        db.update(events).set(values).where(eq(events.id, eventId)),
        db.delete(eventAttendees).where(eq(eventAttendees.eventId, eventId)),
      ]
    : [db.insert(events).values({ id: eventId, ...values })];
  if (attendeeRows.length > 0) {
    statements.push(db.insert(eventAttendees).values(attendeeRows));
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

function isDuplicateMessageError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.includes("UNIQUE constraint failed") &&
    text.includes("message_id_header")
  );
}

// Threading per DESIGN.md §4: a message joins the thread of any message it
// references (References/In-Reply-To); failing that, a reply-marked subject
// joins the most recent thread with the same normalized subject. Returns
// null when a new thread should be created.
async function resolveThreadId(
  db: DrizzleD1Database,
  mailboxId: string,
  subjectNorm: string,
  isReply: boolean,
  referenceIds: string[],
): Promise<string | null> {
  if (referenceIds.length > 0) {
    const referenced = await db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, mailboxId),
          inArray(messages.messageIdHeader, referenceIds),
        ),
      )
      .orderBy(desc(messages.date))
      .get();
    if (referenced?.threadId) return referenced.threadId;
  }

  if ((isReply || referenceIds.length > 0) && subjectNorm !== "") {
    const bySubject = await db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.mailboxId, mailboxId),
          eq(threads.subjectNorm, subjectNorm),
        ),
      )
      .orderBy(desc(threads.lastMessageAt))
      .get();
    if (bySubject) return bySubject.id;
  }

  return null;
}
