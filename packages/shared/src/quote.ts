// Reply/forward prefill shared by the webmail composer and the API's
// server-side reply drafts (Phase 8), so a draft an agent builds reads exactly
// like one the webmail builds. Plain text only: quoted bodies come from the
// indexed body text, never from (hostile) HTML. The caller formats the date —
// the browser uses the viewer's locale, the server uses UTC.

export interface QuotableMessage {
  fromAddr: string;
  toAddrs: string[];
  subject: string;
  bodyText: string;
}

export function reSubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

export function fwdSubject(subject: string): string {
  return /^fwd?:/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
}

/** "On <when>, <from> wrote:" followed by the body, every line "> "-prefixed. */
export function quoteReplyBody(message: QuotableMessage, when: string): string {
  const quoted = (message.bodyText || "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\nOn ${when}, ${message.fromAddr} wrote:\n${quoted}\n`;
}

/** The "Forwarded message" header block followed by the original body. */
export function forwardBody(message: QuotableMessage, when: string): string {
  return (
    `\n\n---------- Forwarded message ----------\n` +
    `From: ${message.fromAddr}\nDate: ${when}\n` +
    `Subject: ${message.subject}\nTo: ${message.toAddrs.join(", ")}\n\n` +
    `${message.bodyText || ""}\n`
  );
}
