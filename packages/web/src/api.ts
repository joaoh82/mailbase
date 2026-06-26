// Thin typed client for the mailbase API. Same origin (/api) in dev and
// production, so plain fetch with credentials; the CSRF token from
// login / /api/auth/me is attached to every mutation.

export interface User {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export type MailboxRole = "owner" | "member";

export interface Mailbox {
  id: string;
  name: string;
  /** From name on this mailbox's outbound mail; '' falls back to the sender's. */
  displayName: string;
  domain: string;
  address: string;
  role: MailboxRole;
  unread: number;
  /** Default signature (HTML) used when a sending identity has none. */
  signature: string;
}

export type Folder = "inbox" | "sent" | "archive" | "trash" | "spam";

export type MessageDirection = "inbound" | "outbound";
/** '' (fine), or 'bounced' / 'complained' once a provider webhook reports it. */
export type DeliveryStatus = "" | "bounced" | "complained" | string;

/** A user-defined label (MAIL-16), scoped to a shared mailbox. */
export interface Label {
  id: string;
  mailboxId: string;
  name: string;
  /** '' (default chip styling) or a "#rrggbb" hex value. */
  color: string;
}

export interface MessageListItem {
  id: string;
  threadId: string | null;
  fromAddr: string;
  toAddrs: string[];
  subject: string;
  snippet: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  folder: Folder;
  direction: MessageDirection;
  deliveryStatus: DeliveryStatus;
  /** Labels applied to this message, sorted by name (MAIL-16). */
  labels: Label[];
  // Only set in the unified "all inboxes" view (Phase 5), so the row can show
  // which mailbox a message landed in.
  mailboxId?: string;
  mailboxAddress?: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MessageDetail extends MessageListItem {
  mailboxId: string;
  bodyText: string;
  size: number;
  attachments: AttachmentMeta[];
}

export interface ThreadResponse {
  thread: {
    id: string;
    mailboxId: string;
    messageCount: number;
    lastMessageAt: string;
  };
  messages: MessageDetail[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken = "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  if (method !== "GET") {
    headers.set("X-CSRF-Token", csrfToken);
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function login(email: string, password: string): Promise<User> {
  const body = await request<{ user: User; csrfToken: string }>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
  );
  csrfToken = body.csrfToken;
  return body.user;
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" });
  csrfToken = "";
}

/** Restores the session (and CSRF token) after a page reload. */
export async function fetchMe(): Promise<User> {
  const body = await request<{ user: User; csrfToken: string }>("/api/auth/me");
  csrfToken = body.csrfToken;
  return body.user;
}

export function listMailboxes(): Promise<{ mailboxes: Mailbox[] }> {
  return request("/api/mailboxes");
}

export interface MailboxChange {
  id: string;
  /** Max message created_at (epoch seconds) in the mailbox; null if empty. */
  latestAt: number | null;
  /** Inbox unread count, matching the sidebar badge. */
  unread: number;
}

/**
 * Cheap "anything changed?" probe for the live-update poll (MAIL-14): one row
 * per mailbox the user belongs to. The client compares successive responses and
 * only refetches the active view when the signal moves. Membership-scoped
 * server-side.
 */
export function pollChanges(): Promise<{ mailboxes: MailboxChange[] }> {
  return request("/api/mailboxes/changes");
}

export function listMessages(
  mailboxId: string,
  folder: Folder,
  cursor?: string | null,
  labelId?: string | null,
): Promise<{ messages: MessageListItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ folder });
  if (cursor) params.set("cursor", cursor);
  if (labelId) params.set("labelId", labelId);
  return request(`/api/mailboxes/${mailboxId}/messages?${params}`);
}

export function searchMessages(
  mailboxId: string,
  q: string,
): Promise<{ messages: MessageListItem[] }> {
  const params = new URLSearchParams({ q });
  return request(`/api/mailboxes/${mailboxId}/search?${params}`);
}

/** Unified "all inboxes" view (Phase 5): one folder across every mailbox. */
export function listAllMessages(
  folder: Folder,
  cursor?: string | null,
): Promise<{ messages: MessageListItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ folder });
  if (cursor) params.set("cursor", cursor);
  return request(`/api/mailboxes/all/messages?${params}`);
}

export function fetchThread(threadId: string): Promise<ThreadResponse> {
  return request(`/api/threads/${threadId}`);
}

export function fetchMessage(id: string): Promise<{ message: MessageDetail }> {
  return request(`/api/messages/${id}`);
}

export function fetchMessageFull(
  id: string,
): Promise<{ html: string | null; text: string | null }> {
  return request(`/api/messages/${id}/full`);
}

export function setRead(id: string, isRead: boolean): Promise<unknown> {
  return request(`/api/messages/${id}/read`, {
    method: "POST",
    body: JSON.stringify({ isRead }),
  });
}

export function setStarred(id: string, isStarred: boolean): Promise<unknown> {
  return request(`/api/messages/${id}/star`, {
    method: "POST",
    body: JSON.stringify({ isStarred }),
  });
}

export function moveMessage(
  id: string,
  folder: "inbox" | "archive" | "trash",
): Promise<unknown> {
  return request(`/api/messages/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ folder }),
  });
}

// --- Labels (MAIL-16) -------------------------------------------------------

/** Labels defined on a mailbox the user belongs to (sidebar + apply menu). */
export function listLabels(mailboxId: string): Promise<{ labels: Label[] }> {
  return request(`/api/labels?mailboxId=${encodeURIComponent(mailboxId)}`);
}

export function createLabel(
  mailboxId: string,
  name: string,
  color = "",
): Promise<{ label: Label }> {
  return request("/api/labels", {
    method: "POST",
    body: JSON.stringify({ mailboxId, name, color }),
  });
}

export function updateLabel(
  labelId: string,
  patch: { name?: string; color?: string },
): Promise<{ label: Label }> {
  return request(`/api/labels/${labelId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteLabel(labelId: string): Promise<unknown> {
  return request(`/api/labels/${labelId}`, { method: "DELETE" });
}

/** Apply a label to a message (idempotent). */
export function applyLabel(messageId: string, labelId: string): Promise<unknown> {
  return request(`/api/messages/${messageId}/labels/${labelId}`, {
    method: "PUT",
  });
}

/** Remove a label from a message (idempotent). */
export function removeLabel(
  messageId: string,
  labelId: string,
): Promise<unknown> {
  return request(`/api/messages/${messageId}/labels/${labelId}`, {
    method: "DELETE",
  });
}

export function mintAttachmentUrl(
  messageId: string,
  attachmentId: string,
): Promise<{ url: string; expiresAt: string }> {
  return request(`/api/messages/${messageId}/attachments/${attachmentId}/url`);
}

// --- Calendar (Phase 7 / MAIL-27) ------------------------------------------

export type Partstat =
  | "needs-action"
  | "accepted"
  | "tentative"
  | "declined"
  | string;

export interface CalendarAttendee {
  addr: string;
  displayName: string;
  partstat: Partstat;
  role: string;
  /** True for the viewer's own attendee line. */
  isSelf: boolean;
}

export interface CalendarEvent {
  id: string;
  mailboxId: string;
  /** The message this invite arrived on, or null. */
  messageId: string | null;
  uid: string;
  sequence: number;
  method: string;
  status: "confirmed" | "cancelled" | "tentative" | string;
  summary: string;
  description: string;
  location: string;
  organizerAddr: string;
  /** Start instant, ISO 8601 (UTC). */
  startsAt: string;
  /** End instant ISO, or null when the invite carried no end. */
  endsAt: string | null;
  allDay: boolean;
  tzid: string;
  /** Raw RRULE value; '' when non-recurring. */
  rrule: string;
  attendees: CalendarAttendee[];
}

/**
 * Events overlapping [fromIso, toIso]. Omit mailboxId for the unified "all
 * inboxes" calendar; pass a specific mailbox id to scope to it. (Don't pass the
 * "all" sentinel — the caller maps that to undefined.)
 */
export function listCalendarEvents(
  fromIso: string,
  toIso: string,
  mailboxId?: string,
): Promise<{ events: CalendarEvent[] }> {
  const params = new URLSearchParams({ from: fromIso, to: toIso });
  if (mailboxId) params.set("mailboxId", mailboxId);
  return request(`/api/calendar/events?${params}`);
}

export function getCalendarEvent(id: string): Promise<{ event: CalendarEvent }> {
  return request(`/api/events/${id}`);
}

/** The calendar event a message carries (an invite), or null. For the RSVP card. */
export function getMessageEvent(
  messageId: string,
): Promise<{ event: CalendarEvent | null }> {
  return request(`/api/messages/${messageId}/event`);
}

/** RSVP to an invite: sends a REPLY to the organizer, returns the new status. */
export function rsvpEvent(
  eventId: string,
  partstat: "accepted" | "tentative" | "declined",
): Promise<{ partstat: string }> {
  return request(`/api/events/${eventId}/rsvp`, {
    method: "POST",
    body: JSON.stringify({ partstat }),
  });
}

export interface CreateEventInput {
  mailboxId: string;
  summary: string;
  /** Start instant, ISO 8601. */
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  tzid?: string;
  location?: string;
  description?: string;
  attendees: string[];
}

/** Create an invite and send a REQUEST to its attendees (MAIL-30). */
export function createCalendarEvent(
  input: CreateEventInput,
): Promise<{ event: CalendarEvent }> {
  return request("/api/calendar/events", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Edit an organized event: bump SEQUENCE and re-send the REQUEST (MAIL-30/33). */
export function updateCalendarEvent(
  id: string,
  input: Omit<CreateEventInput, "mailboxId">,
): Promise<{ event: CalendarEvent }> {
  return request(`/api/calendar/events/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** Cancel an organized event: send a CANCEL and mark it cancelled (MAIL-30/33). */
export function cancelCalendarEvent(id: string): Promise<{ ok: boolean }> {
  return request(`/api/calendar/events/${id}`, { method: "DELETE" });
}

export interface Identity {
  id: string;
  address: string;
  displayName: string;
  /**
   * The owning mailbox's From name. It WINS over this identity's displayName on
   * send (MAIL-22), so the composer shows it as the effective From; '' falls
   * back to displayName.
   */
  mailboxDisplayName: string;
  mailboxId: string;
  /** This identity's own signature (HTML); '' falls back to the mailbox's. */
  signature: string;
  /** The owning mailbox's default signature (HTML), for compose-time fallback. */
  mailboxSignature: string;
}

export function listIdentities(): Promise<{ identities: Identity[] }> {
  return request("/api/send/identities");
}

/** Update one of the user's own send-as identity signatures (sanitized server-side). */
export function updateIdentitySignature(
  identityId: string,
  signature: string,
): Promise<{ signature: string }> {
  return request(`/api/send/identities/${identityId}`, {
    method: "PATCH",
    body: JSON.stringify({ signature }),
  });
}

/** Update a mailbox's default signature (any member; sanitized server-side). */
export function updateMailboxSignature(
  mailboxId: string,
  signature: string,
): Promise<{ signature: string }> {
  return request(`/api/mailboxes/${mailboxId}/signature`, {
    method: "PATCH",
    body: JSON.stringify({ signature }),
  });
}

/**
 * Update a mailbox's From display name (owner/admin only; sanitized
 * server-side). '' reverts the From to each sender's own identity name.
 */
export function updateMailboxDisplayName(
  mailboxId: string,
  displayName: string,
): Promise<{ displayName: string }> {
  return request(`/api/mailboxes/${mailboxId}/display-name`, {
    method: "PATCH",
    body: JSON.stringify({ displayName }),
  });
}

export interface SendPayload {
  identityId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  /** Formatted HTML body from the composer; sanitized server-side on send. */
  html?: string;
  inReplyTo?: string;
  uploadIds?: string[];
}

export function sendMail(
  payload: SendPayload,
): Promise<{ message: MessageDetail; providerMessageId: string }> {
  return request("/api/send", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export interface UploadResult {
  uploadId: string;
  filename: string;
  mimeType: string;
  size: number;
}

// --- Members & invitations (Phase 4) ---------------------------------------

export interface MailboxMember {
  userId: string;
  email: string;
  displayName: string;
  role: MailboxRole;
}

export function listMembers(
  mailboxId: string,
): Promise<{ members: MailboxMember[] }> {
  return request(`/api/mailboxes/${mailboxId}/members`);
}

export function addMember(
  mailboxId: string,
  email: string,
  role: MailboxRole,
): Promise<unknown> {
  return request(`/api/mailboxes/${mailboxId}/members`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export function removeMember(
  mailboxId: string,
  userId: string,
): Promise<unknown> {
  return request(`/api/mailboxes/${mailboxId}/members/${userId}`, {
    method: "DELETE",
  });
}

export interface InviteResult {
  token: string;
  url: string;
  email: string;
  expiresAt: string;
}

export function createInvite(
  email: string,
  mailboxId: string,
  role: MailboxRole,
): Promise<InviteResult> {
  return request("/api/invites", {
    method: "POST",
    body: JSON.stringify({ email, mailboxId, role }),
  });
}

export interface InvitePreview {
  email: string;
  mailbox: string | null;
}

/** Public: read an invite's details for the accept screen (no session). */
export function getInvite(token: string): Promise<InvitePreview> {
  return request(`/api/invites/${token}`);
}

/**
 * Public: accept an invite, creating the account and signing it in. Stores the
 * returned CSRF token so the new session can immediately make mutations.
 */
export async function acceptInvite(
  token: string,
  password: string,
  displayName: string,
): Promise<User> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const res = await fetch(`/api/invites/${token}/accept`, {
    method: "POST",
    headers,
    body: JSON.stringify({ password, displayName }),
    credentials: "same-origin",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { user: User; csrfToken: string };
  csrfToken = data.csrfToken;
  return data.user;
}

/** Stages one attachment in R2 (multipart, so it sets its own Content-Type). */
export async function uploadAttachment(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/send/uploads", {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: form,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as UploadResult;
}

// --- Domain administration (Phase 5, admin only) ---------------------------

export interface AdminDomain {
  id: string;
  name: string;
  rejectUnknown: boolean;
  catchAllMailboxId: string | null;
  resendVerified: boolean;
  /** False for domains seeded by hand (no Cloudflare/Resend handles). */
  managed: boolean;
  cloudflareZoneId: string;
  resendDomainId: string;
  mailboxCount: number;
  addressCount: number;
}

export interface DnsRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl: string;
  status?: string;
  priority?: number;
}

export interface AddDomainResult {
  domain: Omit<AdminDomain, "mailboxCount" | "addressCount">;
  nameServers: string[];
  zoneStatus: string;
  resendStatus: string;
  records: DnsRecord[];
  simulated: boolean;
}

export interface DomainMailbox {
  id: string;
  name: string;
  /** From name on this mailbox's outbound mail (MAIL-22). */
  displayName: string;
  address: string;
  addresses: { id: string; localPart: string; address: string }[];
}

export interface DomainDetail {
  domain: Omit<AdminDomain, "mailboxCount" | "addressCount">;
  mailboxes: DomainMailbox[];
}

export interface DomainStatus {
  zone: { id: string; name: string; status: string; nameServers: string[] } | null;
  emailRouting: { enabled: boolean; status: string } | null;
  catchAll: { enabled: boolean; action: string; targets: string[] } | null;
  resend: {
    status: string;
    records: {
      record: string;
      name: string;
      type: string;
      value: string;
      status: string;
    }[];
  } | null;
  simulated: boolean;
}

export interface ApexMxConflict {
  kind: "apex_mx";
  records: { id: string; name: string; content: string; priority?: number }[];
}

export interface ProvisionStep {
  step: string;
  ok: boolean;
  detail: string;
  conflict?: ApexMxConflict;
}

export interface ProvisionResult {
  steps: ProvisionStep[];
  simulated: boolean;
}

export interface ResolveMxConflictResult extends ProvisionResult {
  removed: { name: string; content: string }[];
}

export function listDomains(): Promise<{ domains: AdminDomain[] }> {
  return request("/api/admin/domains");
}

export function addDomain(name: string, mailbox: string): Promise<AddDomainResult> {
  return request("/api/admin/domains", {
    method: "POST",
    body: JSON.stringify({ name, mailbox }),
  });
}

export function getDomainDetail(id: string): Promise<DomainDetail> {
  return request(`/api/admin/domains/${id}`);
}

export function getDomainStatus(id: string): Promise<DomainStatus> {
  return request(`/api/admin/domains/${id}/status`);
}

export function provisionDomain(id: string): Promise<ProvisionResult> {
  return request(`/api/admin/domains/${id}/provision`, { method: "POST" });
}

export function resolveMxConflict(id: string): Promise<ResolveMxConflictResult> {
  return request(`/api/admin/domains/${id}/resolve-mx-conflict`, {
    method: "POST",
  });
}

export function verifyDomain(id: string): Promise<DomainStatus> {
  return request(`/api/admin/domains/${id}/verify`, { method: "POST" });
}

export function setDomainPolicy(
  id: string,
  policy: { rejectUnknown: boolean; catchAllMailboxId: string | null },
): Promise<unknown> {
  return request(`/api/admin/domains/${id}`, {
    method: "PATCH",
    body: JSON.stringify(policy),
  });
}

export function addDomainMailbox(
  id: string,
  name: string,
  displayName: string,
): Promise<{ id: string; name: string; displayName: string; address: string }> {
  return request(`/api/admin/domains/${id}/mailboxes`, {
    method: "POST",
    body: JSON.stringify({ name, displayName }),
  });
}

export function deleteDomainMailbox(id: string, mailboxId: string): Promise<unknown> {
  return request(`/api/admin/domains/${id}/mailboxes/${mailboxId}`, {
    method: "DELETE",
  });
}

export function addDomainAddress(
  id: string,
  localPart: string,
  mailboxId: string,
): Promise<{ id: string; localPart: string; address: string }> {
  return request(`/api/admin/domains/${id}/addresses`, {
    method: "POST",
    body: JSON.stringify({ localPart, mailboxId }),
  });
}

export function deleteDomainAddress(id: string, addressId: string): Promise<unknown> {
  return request(`/api/admin/domains/${id}/addresses/${addressId}`, {
    method: "DELETE",
  });
}
