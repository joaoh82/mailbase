// Outbound mail abstraction. The only place allowed to talk to a concrete
// provider (Resend) is an adapter implementing this interface.

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array | string;
}

export interface OutboundMail {
  /** RFC 5322 mailbox, e.g. `Josh <josh@example.com>` or `josh@example.com`. */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  /**
   * RFC 5322 Message-ID for this message, angle brackets included
   * (`<id@domain>`). We mint and store it so replies thread back to us; the
   * adapter sets it as the outgoing `Message-ID` header.
   */
  messageId?: string;
  /** Parent message's Message-ID, angle brackets included. */
  inReplyTo?: string;
  /** Full References chain, each id with angle brackets, oldest first. */
  references?: string[];
  attachments?: MailAttachment[];
}

export interface SendResult {
  /** Provider-assigned id for the accepted message. */
  messageId: string;
}

export interface MailSender {
  send(mail: OutboundMail): Promise<SendResult>;
}
