import {
  addresses,
  attachments,
  domains,
  htmlToText,
  identities,
  mailboxes,
  type MailAttachment,
  messages,
  normalizeSubject,
  type OutboundMail,
  sanitizeOutboundHtml,
  threads,
} from "@mailbase/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import PostalMime from "postal-mime";
import { getAccessibleMessage } from "../lib/access";
import type { AppEnv } from "../lib/context";
import { getMailSender } from "../lib/mail-sender";
import { buildRawEmail } from "../lib/raw-email";
import { messageDetail } from "../lib/serialize";

const SNIPPET_LENGTH = 160;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB per file
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/i;

export const sendRoutes = new Hono<AppEnv>();

// The identities a user may send as (who-may-send-as-what, DESIGN.md §4). Each
// carries its own signature plus the owning mailbox's default, so the composer
// can resolve which one to insert at compose time (MAIL-4).
sendRoutes.get("/identities", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({
      id: identities.id,
      displayName: identities.displayName,
      localPart: addresses.localPart,
      domain: domains.name,
      mailboxId: addresses.mailboxId,
      signature: identities.signature,
      mailboxSignature: mailboxes.signature,
    })
    .from(identities)
    .innerJoin(addresses, eq(addresses.id, identities.addressId))
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .innerJoin(mailboxes, eq(mailboxes.id, addresses.mailboxId))
    .where(eq(identities.userId, c.get("user").id))
    .orderBy(domains.name, addresses.localPart)
    .all();

  return c.json({
    identities: rows.map((r) => ({
      id: r.id,
      address: `${r.localPart}@${r.domain}`,
      displayName: r.displayName,
      mailboxId: r.mailboxId,
      signature: r.signature,
      mailboxSignature: r.mailboxSignature,
    })),
  });
});

// Update the signature for one of the caller's own send-as identities. The
// where-clause is scoped to this user, so an identity that isn't theirs simply
// matches no row (404). The HTML is sanitized to the outbound allowlist before
// it is stored — we never trust the client (DESIGN.md §5/§6).
sendRoutes.patch("/identities/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (typeof body?.signature !== "string") {
    return c.json({ error: "signature must be a string" }, 400);
  }
  const signature = sanitizeOutboundHtml(body.signature);

  const result = await db
    .update(identities)
    .set({ signature })
    .where(and(eq(identities.id, id), eq(identities.userId, user.id)));
  if (result.meta.changes === 0) {
    return c.json({ error: "Identity not found" }, 404);
  }
  return c.json({ signature });
});

// Stage one attachment in R2 before sending. Returns an opaque uploadId the
// compose form passes back to POST /. Objects live under the user's prefix, so
// a user can only ever reference their own uploads.
sendRoutes.post("/uploads", async (c) => {
  const user = c.get("user");
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "Expected a multipart 'file' field" }, 400);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "Attachment exceeds the 20 MB limit" }, 413);
  }

  const uploadId = crypto.randomUUID();
  const bytes = new Uint8Array(await file.arrayBuffer());
  await c.env.MAIL_BUCKET.put(`outbound-uploads/${user.id}/${uploadId}`, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { filename: file.name || "attachment" },
  });

  return c.json({
    uploadId,
    filename: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
  });
});

// Send a message: validate the chosen identity belongs to the user, send via
// the MailSender, store a Sent copy (raw to R2 + row to D1), and thread replies.
sendRoutes.post("/", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  const identityId = typeof body?.identityId === "string" ? body.identityId : "";
  const to = recipients(body?.to);
  const cc = recipients(body?.cc);
  const bcc = recipients(body?.bcc);
  const subject = typeof body?.subject === "string" ? body.subject : "";
  const clientText = typeof body?.text === "string" ? body.text : "";
  const htmlInput = typeof body?.html === "string" ? body.html : "";
  // Sanitize on the way out (MAIL-2): this is our own composer's HTML, but we
  // never trust the client, so restrict it to a small, email-client-friendly
  // allowlist and strip everything else (scripts, styles, handlers, etc.).
  const sanitizedHtml = htmlInput.trim() ? sanitizeOutboundHtml(htmlInput) : "";
  const html = sanitizedHtml.trim() ? sanitizedHtml : undefined;
  // For a rich body the HTML is the source of truth; derive the plaintext
  // alternative from it so the multipart/alternative parts always agree. Fall
  // back to a client-supplied text only when there is no HTML.
  const text = html ? htmlToText(html) : clientText;
  const inReplyToId =
    typeof body?.inReplyTo === "string" && body.inReplyTo ? body.inReplyTo : null;
  const uploadIds = Array.isArray(body?.uploadIds)
    ? body.uploadIds.filter((v): v is string => typeof v === "string")
    : [];

  if (!identityId) return c.json({ error: "identityId is required" }, 400);
  if (to === null || cc === null || bcc === null) {
    return c.json({ error: "Invalid recipient address" }, 400);
  }
  if (to.length === 0) {
    return c.json({ error: "At least one 'to' recipient is required" }, 400);
  }

  // Identity ownership: the join is scoped to this user, so an identity that
  // isn't theirs simply returns no row.
  const identity = await db
    .select({
      displayName: identities.displayName,
      localPart: addresses.localPart,
      mailboxId: addresses.mailboxId,
      domain: domains.name,
    })
    .from(identities)
    .innerJoin(addresses, eq(addresses.id, identities.addressId))
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(and(eq(identities.id, identityId), eq(identities.userId, user.id)))
    .get();
  if (!identity) {
    return c.json({ error: "You cannot send as that identity" }, 403);
  }

  const fromEmail = `${identity.localPart}@${identity.domain}`;
  const fromHeader = identity.displayName
    ? `${identity.displayName} <${fromEmail}>`
    : fromEmail;
  const sentMailboxId = identity.mailboxId;

  // Reply context: pull the parent (access-checked) for threading headers.
  let inReplyToHeader: string | undefined;
  let references: string[] | undefined;
  let parentMailboxId: string | null = null;
  let parentThreadId: string | null = null;
  if (inReplyToId) {
    const parent = await getAccessibleMessage(db, user.id, inReplyToId);
    if (!parent) return c.json({ error: "Reply target not found" }, 404);
    parentMailboxId = parent.mailboxId;
    parentThreadId = parent.threadId;
    if (parent.messageIdHeader) {
      inReplyToHeader = `<${parent.messageIdHeader}>`;
      references = await buildReferences(c.env, parent.r2Key, parent.messageIdHeader);
    }
  }

  // Load staged attachments up front so a stale upload fails before we send.
  const uploads: LoadedUpload[] = [];
  for (const id of uploadIds) {
    const loaded = await loadUpload(c.env, user.id, id);
    if (!loaded) {
      return c.json(
        { error: "An attachment upload has expired; re-add it and retry" },
        400,
      );
    }
    uploads.push(loaded);
  }
  const mailAttachments: MailAttachment[] = uploads.map((u) => ({
    filename: u.filename,
    contentType: u.mimeType,
    content: u.bytes,
  }));

  const messageId = crypto.randomUUID();
  const rfcMessageId = `${messageId}@${identity.domain}`;
  const date = new Date();
  const outbound: OutboundMail = {
    from: fromHeader,
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    subject,
    text,
    html,
    messageId: `<${rfcMessageId}>`,
    inReplyTo: inReplyToHeader,
    references,
    attachments: mailAttachments.length ? mailAttachments : undefined,
  };

  // Send first: if the provider rejects it, nothing is stored.
  let providerMessageId: string;
  try {
    ({ messageId: providerMessageId } = await getMailSender(c.env).send(outbound));
  } catch (err) {
    console.error("Outbound send failed:", err);
    return c.json({ error: "The mail provider rejected the message" }, 502);
  }

  // The message is already accepted by the provider; from here a failure means
  // a delivered-but-unstored Sent copy. We log providerMessageId (never the
  // body) on failure so it can be reconciled, then surface a 500.
  const attachmentRows: (typeof attachments.$inferInsert)[] = [];
  try {
    // Raw blob is the source of truth; write it before the D1 row (like inbound).
    const rawKey = `${identity.domain}/${sentMailboxId}/${messageId}.eml`;
    const rawBytes = new TextEncoder().encode(buildRawEmail(outbound, date));
    await c.env.MAIL_BUCKET.put(rawKey, rawBytes, {
      httpMetadata: { contentType: "message/rfc822" },
    });

    for (const u of uploads) {
      const attachmentId = crypto.randomUUID();
      const r2Key = `attachments/${identity.domain}/${sentMailboxId}/${messageId}/${attachmentId}`;
      await c.env.MAIL_BUCKET.put(r2Key, u.bytes, {
        httpMetadata: { contentType: u.mimeType },
      });
      attachmentRows.push({
        id: attachmentId,
        messageId,
        filename: u.filename,
        mimeType: u.mimeType,
        size: u.bytes.byteLength,
        r2Key,
      });
    }

    // Outbound threading honors both an explicit reply target and a "Re:"
    // subject, matching how the inbound worker threads the reply that returns.
    const { norm: subjectNorm, isReply: subjectIsReply } =
      normalizeSubject(subject);
    const threadId = await resolveSentThreadId(db, {
      mailboxId: sentMailboxId,
      subjectNorm,
      isReply: Boolean(inReplyToId) || subjectIsReply,
      parentMailboxId,
      parentThreadId,
    });

    const statements: BatchItem<"sqlite">[] = [];
    let finalThreadId: string;
    if (threadId) {
      finalThreadId = threadId;
      statements.push(
        db
          .update(threads)
          .set({
            lastMessageAt: date,
            messageCount: sql`${threads.messageCount} + 1`,
          })
          .where(eq(threads.id, threadId)),
      );
    } else {
      finalThreadId = crypto.randomUUID();
      statements.push(
        db.insert(threads).values({
          id: finalThreadId,
          mailboxId: sentMailboxId,
          subjectNorm,
          lastMessageAt: date,
          messageCount: 1,
        }),
      );
    }

    statements.push(
      db.insert(messages).values({
        id: messageId,
        mailboxId: sentMailboxId,
        r2Key: rawKey,
        threadId: finalThreadId,
        direction: "outbound",
        fromAddr: fromEmail,
        toAddrs: to,
        subject,
        snippet: text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH),
        bodyText: text,
        hasAttachments: attachmentRows.length > 0,
        size: rawBytes.byteLength,
        date,
        isRead: true,
        folder: "sent",
        messageIdHeader: rfcMessageId,
        providerMessageId,
      }),
    );
    if (attachmentRows.length > 0) {
      statements.push(db.insert(attachments).values(attachmentRows));
    }

    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (err) {
    console.error(
      `Message ${providerMessageId} was sent but storing the Sent copy failed:`,
      err,
    );
    return c.json(
      { error: "The message was sent but could not be saved to Sent" },
      500,
    );
  }

  // Best-effort cleanup of the staging objects; harmless if it fails.
  await Promise.all(
    uploadIds.map((id) =>
      c.env.MAIL_BUCKET.delete(`outbound-uploads/${user.id}/${id}`).catch(
        () => undefined,
      ),
    ),
  );

  const stored = await getAccessibleMessage(db, user.id, messageId);
  const storedAttachments = await db
    .select()
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .all();
  return c.json(
    {
      message: stored ? messageDetail(stored, storedAttachments) : null,
      providerMessageId,
    },
    201,
  );
});

interface LoadedUpload {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

async function loadUpload(
  env: Env,
  userId: string,
  uploadId: string,
): Promise<LoadedUpload | null> {
  if (!UPLOAD_ID_RE.test(uploadId)) return null;
  const object = await env.MAIL_BUCKET.get(
    `outbound-uploads/${userId}/${uploadId}`,
  );
  if (!object) return null;
  return {
    filename: object.customMetadata?.filename || "attachment",
    mimeType: object.httpMetadata?.contentType || "application/octet-stream",
    bytes: new Uint8Array(await object.arrayBuffer()),
  };
}

// Returns the recipient list, [] for absent/empty, or null if any entry is not
// a valid address (caller turns null into a 400).
function recipients(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const addr = entry.trim();
    if (!addr) continue;
    if (!EMAIL_RE.test(addr)) return null;
    out.push(addr);
  }
  return out;
}

// Full References chain for a reply: the parent's own References/In-Reply-To
// (parsed from its raw blob) followed by the parent's Message-ID.
async function buildReferences(
  env: Env,
  parentKey: string,
  parentMessageId: string,
): Promise<string[]> {
  const parentRef = `<${parentMessageId}>`;
  try {
    const object = await env.MAIL_BUCKET.get(parentKey);
    if (object) {
      const email = await PostalMime.parse(await object.arrayBuffer());
      const prior =
        `${email.references ?? ""} ${email.inReplyTo ?? ""}`.match(
          /<[^<>\s]+>/g,
        ) ?? [];
      return [...new Set([...prior, parentRef])];
    }
  } catch {
    // Unparseable parent: In-Reply-To alone still threads in most clients.
  }
  return [parentRef];
}

// Outbound threading: a reply joins its parent's thread when they share a
// mailbox; otherwise (and for any reply whose parent is unthreaded) it joins
// the most recent same-subject thread in the sending mailbox. A fresh compose
// always starts its own thread.
async function resolveSentThreadId(
  db: ReturnType<typeof drizzle>,
  opts: {
    mailboxId: string;
    subjectNorm: string;
    isReply: boolean;
    parentMailboxId: string | null;
    parentThreadId: string | null;
  },
): Promise<string | null> {
  if (
    opts.isReply &&
    opts.parentThreadId &&
    opts.parentMailboxId === opts.mailboxId
  ) {
    return opts.parentThreadId;
  }
  if (opts.isReply && opts.subjectNorm) {
    const existing = await db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.mailboxId, opts.mailboxId),
          eq(threads.subjectNorm, opts.subjectNorm),
        ),
      )
      .orderBy(desc(threads.lastMessageAt))
      .get();
    if (existing) return existing.id;
  }
  return null;
}
