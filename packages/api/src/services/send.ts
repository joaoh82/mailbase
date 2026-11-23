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
import type { DrizzleD1Database } from "drizzle-orm/d1";
import PostalMime from "postal-mime";
import { getAccessibleMessage } from "../lib/access";
import { getMailSender } from "../lib/mail-sender";
import { refundWindowHit, registerWindowHit } from "../lib/rate-limit";
import { buildRawEmail } from "../lib/raw-email";
import { messageDetail } from "../lib/serialize";
import { type SendQuota, type ServiceContext, ServiceError } from "./context";

// Outbound mail (DESIGN.md §5): the one implementation of "send a message and
// keep a Sent copy", shared by the webmail's POST /api/send, server-side drafts
// and the agent REST/MCP surface. No caller-specific marker is recorded.

const SNIPPET_LENGTH = 160;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB per file
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/i;
const DAY_SECONDS = 24 * 60 * 60;

export function sendCapKey(tokenId: string): string {
  return `tok:send:${tokenId}`;
}

/** The identities a user may send as, with signatures (MAIL-4). */
export async function listIdentities(ctx: ServiceContext) {
  const rows = await ctx.db
    .select({
      id: identities.id,
      displayName: identities.displayName,
      mailboxDisplayName: mailboxes.displayName,
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
    .where(eq(identities.userId, ctx.userId))
    .orderBy(domains.name, addresses.localPart)
    .all();

  return rows.map((r) => ({
    id: r.id,
    address: `${r.localPart}@${r.domain}`,
    displayName: r.displayName,
    mailboxDisplayName: r.mailboxDisplayName,
    mailboxId: r.mailboxId,
    signature: r.signature,
    mailboxSignature: r.mailboxSignature,
  }));
}

/** An identity the caller owns, with its address and mailbox; null otherwise. */
export async function getOwnedIdentity(
  db: DrizzleD1Database,
  userId: string,
  identityId: string,
) {
  const row = await db
    .select({
      id: identities.id,
      displayName: identities.displayName,
      mailboxDisplayName: mailboxes.displayName,
      localPart: addresses.localPart,
      mailboxId: addresses.mailboxId,
      domain: domains.name,
    })
    .from(identities)
    .innerJoin(addresses, eq(addresses.id, identities.addressId))
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .innerJoin(mailboxes, eq(mailboxes.id, addresses.mailboxId))
    .where(and(eq(identities.id, identityId), eq(identities.userId, userId)))
    .get();
  return row ?? null;
}

export interface StagedUpload {
  uploadId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Stage one attachment in R2 before sending (or attaching to a draft). Objects
 * live under the user's prefix, so a user can only ever reference their own.
 */
export async function stageUpload(
  ctx: ServiceContext,
  file: { filename: string; mimeType: string; bytes: Uint8Array },
): Promise<StagedUpload> {
  if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new ServiceError(413, "Attachment exceeds the 20 MB limit");
  }
  const uploadId = crypto.randomUUID();
  const filename = file.filename || "attachment";
  const mimeType = file.mimeType || "application/octet-stream";
  await ctx.env.MAIL_BUCKET.put(
    `outbound-uploads/${ctx.userId}/${uploadId}`,
    file.bytes,
    {
      httpMetadata: { contentType: mimeType },
      customMetadata: { filename },
    },
  );
  return { uploadId, filename, mimeType, size: file.bytes.byteLength };
}

export interface LoadedUpload {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export function uploadKey(userId: string, uploadId: string): string {
  return `outbound-uploads/${userId}/${uploadId}`;
}

/** A staged upload of this user's, or null if it is unknown or expired. */
export async function loadUpload(
  env: Env,
  userId: string,
  uploadId: string,
): Promise<LoadedUpload | null> {
  if (!UPLOAD_ID_RE.test(uploadId)) return null;
  const object = await env.MAIL_BUCKET.get(uploadKey(userId, uploadId));
  if (!object) return null;
  return {
    filename: object.customMetadata?.filename || "attachment",
    mimeType: object.httpMetadata?.contentType || "application/octet-stream",
    bytes: new Uint8Array(await object.arrayBuffer()),
  };
}

/**
 * The recipient list, [] for absent/empty, or null if any entry is not a valid
 * address. Accepts an array or a comma-separated string.
 */
export function parseRecipients(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  const list =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (!list) return null;
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") return null;
    const addr = entry.trim();
    if (!addr) continue;
    if (!EMAIL_RE.test(addr)) return null;
    out.push(addr);
  }
  return out;
}

export interface SendInput {
  identityId: string;
  to: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: string;
  html?: string;
  text?: string;
  /** Id of the message being replied to (access-checked at send time). */
  inReplyTo?: string | null;
  /** Staged uploads (deleted after a successful send). */
  uploadIds?: string[];
  /** Already-loaded attachments (e.g. a draft's), sent alongside uploads. */
  attachments?: LoadedUpload[];
  /** Agents only: count this send against the token's daily cap. */
  quota?: SendQuota;
}

/**
 * Send a message: validate the identity belongs to the user, sanitize the
 * HTML, send via the MailSender, store a Sent copy (raw to R2 + rows to D1 in
 * one batch, providerMessageId kept for bounce tracking), and thread replies.
 */
export async function sendMessage(ctx: ServiceContext, input: SendInput) {
  const { db, env, userId } = ctx;
  const identityId = input.identityId || "";
  const to = parseRecipients(input.to);
  const cc = parseRecipients(input.cc);
  const bcc = parseRecipients(input.bcc);
  const subject = input.subject ?? "";
  const htmlInput = input.html ?? "";
  // Sanitize on the way out (MAIL-2): we never trust the client (agents are a
  // client too), so restrict HTML to a small, email-client-friendly allowlist.
  const sanitizedHtml = htmlInput.trim() ? sanitizeOutboundHtml(htmlInput) : "";
  const html = sanitizedHtml.trim() ? sanitizedHtml : undefined;
  // For a rich body the HTML is the source of truth; derive the plaintext
  // alternative from it so the multipart/alternative parts always agree.
  const text = html ? htmlToText(html) : (input.text ?? "");
  const inReplyToId = input.inReplyTo || null;
  const uploadIds = input.uploadIds ?? [];

  if (!identityId) throw new ServiceError(400, "identityId is required");
  if (to === null || cc === null || bcc === null) {
    throw new ServiceError(400, "Invalid recipient address");
  }
  if (to.length === 0) {
    throw new ServiceError(400, "At least one 'to' recipient is required");
  }

  // Identity ownership: scoped to this user, so another user's identity simply
  // returns no row.
  const identity = await getOwnedIdentity(db, userId, identityId);
  if (!identity) {
    throw new ServiceError(403, "You cannot send as that identity");
  }

  const fromEmail = `${identity.localPart}@${identity.domain}`;
  // Mailbox name wins (MAIL-22): a shared inbox's display name is the From name
  // for every member; the identity's own name is only the fallback.
  const fromDisplayName = identity.mailboxDisplayName || identity.displayName;
  const fromHeader = fromDisplayName
    ? `${fromDisplayName} <${fromEmail}>`
    : fromEmail;
  const sentMailboxId = identity.mailboxId;

  // Reply context: pull the parent (access-checked) for threading headers.
  let inReplyToHeader: string | undefined;
  let references: string[] | undefined;
  let parentMailboxId: string | null = null;
  let parentThreadId: string | null = null;
  if (inReplyToId) {
    const parent = await getAccessibleMessage(db, userId, inReplyToId);
    if (!parent) throw new ServiceError(404, "Reply target not found");
    parentMailboxId = parent.mailboxId;
    parentThreadId = parent.threadId;
    if (parent.messageIdHeader) {
      inReplyToHeader = `<${parent.messageIdHeader}>`;
      references = await buildReferences(env, parent.r2Key, parent.messageIdHeader);
    }
  }

  // Load staged attachments up front so a stale upload fails before we send.
  const uploads: LoadedUpload[] = [];
  for (const id of uploadIds) {
    const loaded = await loadUpload(env, userId, id);
    if (!loaded) {
      throw new ServiceError(
        400,
        "An attachment upload has expired; re-add it and retry",
      );
    }
    uploads.push(loaded);
  }
  uploads.push(...(input.attachments ?? []));
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

  // The daily send cap is consumed *before* the provider call, so concurrent
  // agents can't overshoot it, and refunded only if the provider refuses.
  if (input.quota) {
    const hit = await registerWindowHit(
      db,
      sendCapKey(input.quota.tokenId),
      DAY_SECONDS,
      input.quota.dailySendCap,
    );
    if (!hit.allowed) {
      throw new ServiceError(
        429,
        `Daily send cap of ${input.quota.dailySendCap} reached for this token`,
        "daily_send_cap_reached",
      );
    }
  }

  // Send first: if the provider rejects it, nothing is stored.
  let providerMessageId: string;
  try {
    ({ messageId: providerMessageId } = await getMailSender(env).send(outbound));
  } catch (err) {
    console.error("Outbound send failed:", err);
    if (input.quota) {
      await refundWindowHit(db, sendCapKey(input.quota.tokenId), DAY_SECONDS);
    }
    throw new ServiceError(502, "The mail provider rejected the message");
  }

  // The message is already accepted by the provider; from here a failure means
  // a delivered-but-unstored Sent copy. We log providerMessageId (never the
  // body) on failure so it can be reconciled, then surface a 500.
  const attachmentRows: (typeof attachments.$inferInsert)[] = [];
  try {
    // Raw blob is the source of truth; write it before the D1 row (like inbound).
    const rawKey = `${identity.domain}/${sentMailboxId}/${messageId}.eml`;
    const rawBytes = new TextEncoder().encode(buildRawEmail(outbound, date));
    await env.MAIL_BUCKET.put(rawKey, rawBytes, {
      httpMetadata: { contentType: "message/rfc822" },
    });

    for (const u of uploads) {
      const attachmentId = crypto.randomUUID();
      const r2Key = `attachments/${identity.domain}/${sentMailboxId}/${messageId}/${attachmentId}`;
      await env.MAIL_BUCKET.put(r2Key, u.bytes, {
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
    throw new ServiceError(
      500,
      "The message was sent but could not be saved to Sent",
    );
  }

  // Best-effort cleanup of the staging objects; harmless if it fails.
  await Promise.all(
    uploadIds.map((id) =>
      env.MAIL_BUCKET.delete(uploadKey(userId, id)).catch(() => undefined),
    ),
  );

  const stored = await getAccessibleMessage(db, userId, messageId);
  const storedAttachments = await db
    .select()
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .all();
  return {
    message: stored ? messageDetail(stored, storedAttachments) : null,
    providerMessageId,
  };
}

// Full References chain for a reply: the parent's own References/In-Reply-To
// (parsed from its raw blob) followed by the parent's Message-ID.
export async function buildReferences(
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
  db: DrizzleD1Database,
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
