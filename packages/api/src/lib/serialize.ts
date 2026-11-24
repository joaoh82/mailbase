import type {
  apiTokens,
  attachments,
  draftAttachments,
  drafts,
  eventAttendees,
  events,
  messages,
} from "@mailbase/shared";
import { tokenStatus } from "./api-token";
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

// Calendar event wire shape (Phase 7). Instants go out as ISO strings; all-day
// events carry allDay so the SPA renders them date-only. Attendees include
// is_self + partstat so the reading-pane RSVP card (MAIL-29) can render status.
export function calendarEvent(
  e: typeof events.$inferSelect,
  attendees: (typeof eventAttendees.$inferSelect)[] = [],
) {
  return {
    id: e.id,
    mailboxId: e.mailboxId,
    messageId: e.messageId,
    uid: e.uid,
    sequence: e.sequence,
    method: e.method,
    status: e.status,
    summary: e.summary,
    description: e.description,
    location: e.location,
    organizerAddr: e.organizerAddr,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt ? e.endsAt.toISOString() : null,
    allDay: e.allDay,
    tzid: e.tzid,
    rrule: e.rrule,
    attendees: attendees.map((a) => ({
      addr: a.addr,
      displayName: a.displayName,
      partstat: a.partstat,
      role: a.role,
      isSelf: a.isSelf,
    })),
  };
}

// Personal API token (Phase 8). Never includes the token or its hash.
export function serializeApiToken(t: typeof apiTokens.$inferSelect) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.tokenPrefix,
    rateLimitPerMinute: t.rateLimitPerMinute,
    dailySendCap: t.dailySendCap,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
    revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
    status: tokenStatus(t),
  };
}

// Server-side draft (Phase 8). Author-private, so no author field is needed.
export function serializeDraft(
  d: typeof drafts.$inferSelect,
  attachmentRows: (typeof draftAttachments.$inferSelect)[] = [],
) {
  return {
    id: d.id,
    mailboxId: d.mailboxId,
    identityId: d.identityId,
    to: d.toAddrs,
    cc: d.ccAddrs,
    bcc: d.bccAddrs,
    subject: d.subject,
    html: d.bodyHtml,
    text: d.bodyText,
    mode: d.mode,
    sourceMessageId: d.sourceMessageId,
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    attachments: attachmentRows.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.contentType,
      size: a.size,
    })),
  };
}
