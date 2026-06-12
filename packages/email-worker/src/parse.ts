import PostalMime, { type Address, type Email } from "postal-mime";

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  content: ArrayBuffer | Uint8Array | string;
}

export interface ParsedInbound {
  subject: string;
  fromAddr: string;
  toAddrs: string[];
  bodyText: string;
  date: Date;
  /** Message-ID without angle brackets; '' when absent or unparseable. */
  messageIdHeader: string;
  /** Ids named in References/In-Reply-To, without angle brackets. */
  referenceIds: string[];
  attachments: ParsedAttachment[];
}

/** Strip angle brackets so stored ids and referenced ids compare equal. */
export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^</, "").replace(/>$/, "");
}

function extractReferenceIds(email: Email): string[] {
  const raw = `${email.references ?? ""} ${email.inReplyTo ?? ""}`;
  const ids = raw.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids.map(normalizeMessageId))];
}

function flattenAddresses(list: Address[] | undefined): string[] {
  const out: string[] = [];
  for (const entry of list ?? []) {
    if (entry.group) {
      for (const member of entry.group) {
        if (member.address) out.push(member.address);
      }
    } else if (entry.address) {
      out.push(entry.address);
    }
  }
  return out;
}

// Last-resort body text for HTML-only emails, good enough for snippets and
// FTS. Phase 2 renders the real HTML from the raw blob in R2.
function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function parseInbound(
  rawBuffer: ArrayBuffer,
  envelope: { from: string; to: string },
): Promise<ParsedInbound> {
  let email: Email | undefined;
  try {
    email = await PostalMime.parse(rawBuffer);
  } catch (error) {
    // Malformed MIME must never lose mail: fall back to envelope metadata;
    // the raw bytes are stored in R2 regardless.
    console.warn(`postal-mime failed to parse message from ${envelope.from}:`, error);
  }

  const fromAddr = (email?.from && email.from.address) || envelope.from;
  const toAddrs = flattenAddresses(email?.to);
  if (toAddrs.length === 0) toAddrs.push(envelope.to);

  const parsedDate = email?.date ? new Date(email.date) : undefined;
  const date =
    parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date();

  const bodyText =
    email?.text?.trim() || (email?.html ? htmlToText(email.html) : "");

  return {
    subject: email?.subject ?? "",
    fromAddr,
    toAddrs,
    bodyText,
    date,
    messageIdHeader: email?.messageId
      ? normalizeMessageId(email.messageId)
      : "",
    referenceIds: email ? extractReferenceIds(email) : [],
    attachments: (email?.attachments ?? []).map((att) => ({
      filename: att.filename || "attachment",
      mimeType: att.mimeType || "application/octet-stream",
      content: att.content,
    })),
  };
}
