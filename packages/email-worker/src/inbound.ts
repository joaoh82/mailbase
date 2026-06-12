import {
  addresses,
  attachments,
  domains,
  messages,
  threads,
} from "@mailbase/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { parseInbound } from "./parse";
import { normalizeSubject } from "./thread";

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
  await db.batch(
    statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
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
