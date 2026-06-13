import { bytesToBase64, type MailAttachment, type OutboundMail } from "@mailbase/shared";

// Builds the RFC 5322 bytes we store in R2 for a sent message. This is our own
// faithful copy for the Sent folder, "view original", and a future IMAP bridge
// — it is NOT the exact wire format Resend transmits (Resend re-signs with DKIM
// and may rewrite some headers). Bodies and attachments are base64-encoded so
// arbitrary UTF-8 and binary survive without line-length games.

const encoder = new TextEncoder();

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

// RFC 2047 encoded-word for header values that aren't plain ASCII. CR/LF are
// stripped first so a hostile subject or display name can never inject extra
// headers into the stored message (header injection).
function encodeHeaderWord(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  if (isAscii(clean)) return clean;
  return `=?UTF-8?B?${bytesToBase64(encoder.encode(clean))}?=`;
}

/** Wrap a base64 string into 76-character CRLF lines (RFC 2045). */
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join("\r\n");
}

function base64Of(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  return wrap76(bytesToBase64(bytes));
}

interface Entity {
  headers: string[];
  body: string;
}

function renderEntity(entity: Entity): string {
  return `${entity.headers.join("\r\n")}\r\n\r\n${entity.body}`;
}

function textEntity(kind: "plain" | "html", text: string): Entity {
  return {
    headers: [
      `Content-Type: text/${kind}; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
    ],
    body: base64Of(text),
  };
}

function attachmentEntity(att: MailAttachment): Entity {
  const name = att.filename.replace(/[\r\n"\\]/g, "_");
  return {
    headers: [
      `Content-Type: ${att.contentType || "application/octet-stream"}; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`,
    ],
    body: base64Of(att.content),
  };
}

function multipart(subtype: "alternative" | "mixed", parts: Entity[]): Entity {
  const boundary = `mb_${subtype}_${crypto.randomUUID().replace(/-/g, "")}`;
  const body = `${parts
    .map((p) => `--${boundary}\r\n${renderEntity(p)}`)
    .join("\r\n")}\r\n--${boundary}--\r\n`;
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
    body,
  };
}

function bodyEntity(mail: OutboundMail): Entity {
  const text = mail.text ?? "";
  const html = mail.html;
  if (html && text) {
    return multipart("alternative", [
      textEntity("plain", text),
      textEntity("html", html),
    ]);
  }
  if (html) return textEntity("html", html);
  return textEntity("plain", text);
}

export function buildRawEmail(mail: OutboundMail, date: Date): string {
  let root = bodyEntity(mail);
  if (mail.attachments && mail.attachments.length > 0) {
    root = multipart("mixed", [root, ...mail.attachments.map(attachmentEntity)]);
  }

  const headers: string[] = [`From: ${encodeHeaderWord(mail.from)}`];
  if (mail.to.length) headers.push(`To: ${mail.to.join(", ")}`);
  if (mail.cc?.length) headers.push(`Cc: ${mail.cc.join(", ")}`);
  if (mail.bcc?.length) headers.push(`Bcc: ${mail.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderWord(mail.subject)}`);
  headers.push(`Date: ${date.toUTCString()}`);
  if (mail.messageId) headers.push(`Message-ID: ${mail.messageId}`);
  if (mail.inReplyTo) headers.push(`In-Reply-To: ${mail.inReplyTo}`);
  if (mail.references?.length) {
    headers.push(`References: ${mail.references.join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");

  return `${[...headers, ...root.headers].join("\r\n")}\r\n\r\n${root.body}`;
}
