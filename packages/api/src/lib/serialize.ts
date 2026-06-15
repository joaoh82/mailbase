import type { attachments, messages } from "@mailbase/shared";
import type { SerializedLabel } from "./labels";

// Wire shapes for the SPA. Dates go out as ISO strings; body_text only on
// detail/thread responses, never in folder listings. Labels travel on both
// rows and detail so the SPA can render chips (MAIL-16); callers pass the
// message's labels (default none) — see labelsByMessage in lib/labels.

export function messageListItem(
  m: typeof messages.$inferSelect,
  labels: SerializedLabel[] = [],
) {
  return {
    id: m.id,
    threadId: m.threadId,
    fromAddr: m.fromAddr,
    toAddrs: m.toAddrs,
    subject: m.subject,
    snippet: m.snippet,
    date: m.date.toISOString(),
    isRead: m.isRead,
    isStarred: m.isStarred,
    hasAttachments: m.hasAttachments,
    folder: m.folder,
    direction: m.direction,
    deliveryStatus: m.deliveryStatus,
    labels,
  };
}

export function messageDetail(
  m: typeof messages.$inferSelect,
  attachmentRows: (typeof attachments.$inferSelect)[],
  labels: SerializedLabel[] = [],
) {
  return {
    ...messageListItem(m, labels),
    mailboxId: m.mailboxId,
    bodyText: m.bodyText,
    size: m.size,
    attachments: attachmentRows.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
  };
}
