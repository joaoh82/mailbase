// Thin typed client for the mailbase API. Same origin (/api) in dev and
// production, so plain fetch with credentials; the CSRF token from
// login / /api/auth/me is attached to every mutation.

export interface User {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export interface Mailbox {
  id: string;
  name: string;
  domain: string;
  address: string;
  unread: number;
}

export type Folder = "inbox" | "sent" | "archive" | "trash" | "spam";

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
