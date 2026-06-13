import {
  bytesToBase64,
  type MailSender,
  type OutboundMail,
  type SendResult,
} from "@mailbase/shared";

// ResendMailSender is the ONLY place in the codebase that talks to Resend
// (DESIGN.md §2.4 — outbound is abstracted behind MailSender). Everything else
// sends through the MailSender interface, so swapping in Postmark/SES/Cloudflare
// Email Service later touches only this file. We call the REST API with fetch
// rather than the Resend SDK: one fewer dependency and it bundles cleanly for
// the Workers runtime.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Standard base64 with `=` padding, which Resend's decoder expects. */
function paddedBase64(content: string | Uint8Array): string {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const b64 = bytesToBase64(bytes);
  return b64 + "=".repeat((4 - (b64.length % 4)) % 4);
}

export class ResendMailSender implements MailSender {
  constructor(private readonly apiKey: string) {}

  async send(mail: OutboundMail): Promise<SendResult> {
    const headers: Record<string, string> = {};
    if (mail.messageId) headers["Message-ID"] = mail.messageId;
    if (mail.inReplyTo) headers["In-Reply-To"] = mail.inReplyTo;
    if (mail.references?.length) {
      headers["References"] = mail.references.join(" ");
    }

    const payload = {
      from: mail.from,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.bcc,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      attachments: mail.attachments?.map((a) => ({
        filename: a.filename,
        content: paddedBase64(a.content),
        content_type: a.contentType,
      })),
    };

    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Resend send failed (${res.status}): ${detail}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("Resend send returned no id");
    return { messageId: data.id };
  }
}

// Used when RESEND_API_KEY is unset (local dev, tests): accepts the message and
// returns a fake id WITHOUT any network call, so the send/store/thread pipeline
// is exercisable offline and tests can never reach Resend.
export class MockMailSender implements MailSender {
  async send(_mail: OutboundMail): Promise<SendResult> {
    return { messageId: `mock-${crypto.randomUUID()}` };
  }
}

export function getMailSender(env: Env): MailSender {
  if (env.RESEND_API_KEY) return new ResendMailSender(env.RESEND_API_KEY);
  console.warn(
    "RESEND_API_KEY not set: using MockMailSender; mail is recorded locally but not delivered.",
  );
  return new MockMailSender();
}
