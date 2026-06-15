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
): Promise<{ messages: MessageListItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ folder });
  if (cursor) params.set("cursor", cursor);
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

export function mintAttachmentUrl(
  messageId: string,
  attachmentId: string,
): Promise<{ url: string; expiresAt: string }> {
  return request(`/api/messages/${messageId}/attachments/${attachmentId}/url`);
}

export interface Identity {
  id: string;
  address: string;
  displayName: string;
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

export interface ProvisionResult {
  steps: { step: string; ok: boolean; detail: string }[];
  simulated: boolean;
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
): Promise<{ id: string; name: string; address: string }> {
  return request(`/api/admin/domains/${id}/mailboxes`, {
    method: "POST",
    body: JSON.stringify({ name }),
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
