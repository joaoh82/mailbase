import {
  attachments,
  type DraftMode,
  forwardBody,
  fwdSubject,
  htmlToText,
  plainTextToHtml,
  quoteReplyBody,
  reSubject,
  sanitizeOutboundHtml,
} from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { getAccessibleMessage } from "../lib/access";
import { type ServiceContext, ServiceError } from "./context";
import { parseRawMessage } from "./mail-query";
import { listIdentities } from "./send";

// Server-side reply / reply-all / forward builders (Phase 8). Agents get the
// same prefill the webmail builds client-side: same subject prefixes and the
// same plain-text quote (packages/shared/src/quote.ts). Reply-all recovers Cc
// from the parent's raw .eml, because D1 stores only To.

export type ReplyMode = Exclude<DraftMode, "new">;
export const REPLY_MODES: readonly ReplyMode[] = ["reply", "reply_all", "forward"];

export interface ComposedDraft {
  mailboxId: string;
  identityId: string;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  text: string;
  mode: ReplyMode;
  sourceMessageId: string;
  /** Parent attachments a forward carries (copied into the draft by the caller). */
  forwardAttachments: (typeof attachments.$inferSelect)[];
}

function dedupe(list: string[], exclude: Set<string>): string[] {
  const out: string[] = [];
  for (const addr of list) {
    const key = addr.trim().toLowerCase();
    if (!key || exclude.has(key)) continue;
    exclude.add(key);
    out.push(addr.trim());
  }
  return out;
}

/**
 * Build a reply / reply-all / forward of `messageId`. `body` (text or HTML) is
 * the new content placed above the quote. The From identity is the caller's
 * identity in the parent's mailbox, preferring the address the parent was sent
 * to. Access to the parent is checked here and again when the draft is sent.
 */
export async function composeFromMessage(
  ctx: ServiceContext,
  messageId: string,
  mode: ReplyMode,
  body: { text?: string; html?: string } = {},
): Promise<ComposedDraft> {
  if (!REPLY_MODES.includes(mode)) {
    throw new ServiceError(400, "mode must be reply, reply_all or forward");
  }
  const parent = await getAccessibleMessage(ctx.db, ctx.userId, messageId);
  if (!parent) throw new ServiceError(404, "Message not found");

  const raw = await parseRawMessage(ctx.env, parent.r2Key);
  const headers = raw?.headers ?? null;
  const parentTo = parent.toAddrs.length ? parent.toAddrs : (headers?.to ?? []);
  const parentCc = headers?.cc ?? [];

  const identities = await listIdentities(ctx);
  const selfAddrs = new Set(identities.map((i) => i.address.toLowerCase()));
  const inMailbox = identities.filter((i) => i.mailboxId === parent.mailboxId);
  const addressedTo = new Set(
    [...parentTo, ...parentCc].map((a) => a.toLowerCase()),
  );
  const identity =
    inMailbox.find((i) => addressedTo.has(i.address.toLowerCase())) ??
    inMailbox[0];
  if (!identity) {
    throw new ServiceError(403, "You have no identity to send from in this mailbox");
  }

  const when = parent.date.toUTCString();
  const quotable = {
    fromAddr: parent.fromAddr,
    toAddrs: parentTo,
    subject: parent.subject,
    bodyText: parent.bodyText,
  };

  let to: string[] = [];
  let cc: string[] = [];
  let subject: string;
  let quote: string;
  let forwardAttachments: ComposedDraft["forwardAttachments"] = [];
  if (mode === "forward") {
    subject = fwdSubject(parent.subject);
    quote = forwardBody(quotable, when);
    forwardAttachments = await ctx.db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, parent.id))
      .all();
  } else {
    subject = reSubject(parent.subject);
    quote = quoteReplyBody(quotable, when);
    // Replying to our own sent mail goes back to its recipients; otherwise to
    // Reply-To when the sender set one, else From.
    const target =
      parent.direction === "outbound"
        ? parentTo
        : headers?.replyTo.length
          ? headers.replyTo
          : [parent.fromAddr];
    const seen = new Set(selfAddrs);
    to = dedupe(target, seen);
    if (to.length === 0) to = dedupe(target, new Set());
    if (mode === "reply_all") {
      cc = dedupe(
        parent.direction === "outbound" ? parentCc : [...parentTo, ...parentCc],
        seen,
      );
    }
  }

  const newHtml = body.html?.trim() ? sanitizeOutboundHtml(body.html) : "";
  const newText = newHtml ? htmlToText(newHtml) : (body.text ?? "");
  const text = `${newText}${quote}`;
  const html = newHtml
    ? `${newHtml}${plainTextToHtml(quote.replace(/^\n+/, ""))}`
    : plainTextToHtml(text);

  return {
    mailboxId: parent.mailboxId,
    identityId: identity.id,
    to,
    cc,
    subject,
    html,
    text,
    mode,
    sourceMessageId: parent.id,
    forwardAttachments,
  };
}
