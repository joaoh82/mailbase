// Outbound mail abstraction. The only place allowed to talk to a concrete
// provider (Resend) is an adapter implementing this interface.

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array | string;
}

export interface OutboundMail {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
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
