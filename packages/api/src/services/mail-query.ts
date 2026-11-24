import {
  attachments,
  domains,
  labels,
  mailboxes,
  mailboxMembers,
  MESSAGE_FOLDERS,
  messageLabels,
  messages,
  type MessageFolder,
} from "@mailbase/shared";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import PostalMime from "postal-mime";
import {
  getAccessibleMessage,
  getAccessibleThread,
  hasMailboxAccess,
} from "../lib/access";
import { labelsByMessage } from "../lib/labels";
import { messageDetail, messageListItem } from "../lib/serialize";
import { type ServiceContext, ServiceError } from "./context";

// Reading mail (DESIGN.md §5), shared by the webmail routes and the agent
// REST/MCP surface. Every read is scoped by mailbox membership.

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export function pageSize(raw: unknown): number {
  return Math.min(Math.max(Number(raw) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

async function requireMailbox(ctx: ServiceContext, mailboxId: string) {
  if (!(await hasMailboxAccess(ctx.db, ctx.userId, mailboxId))) {
    throw new ServiceError(404, "Mailbox not found");
  }
}

/** All mailboxes the user is a member of, with inbox unread counts. */
export async function listMailboxes(ctx: ServiceContext) {
  const { db } = ctx;
  const rows = await db
    .select({
      id: mailboxes.id,
      name: mailboxes.name,
      displayName: mailboxes.displayName,
      domain: domains.name,
      role: mailboxMembers.role,
      signature: mailboxes.signature,
    })
    .from(mailboxMembers)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxMembers.mailboxId))
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(eq(mailboxMembers.userId, ctx.userId))
    .orderBy(domains.name, mailboxes.name)
    .all();

  const unreadByMailbox = new Map<string, number>();
  if (rows.length > 0) {
    const counts = await db
      .select({
        mailboxId: messages.mailboxId,
        unread: sql<number>`count(*)`,
      })
      .from(messages)
      .where(
        and(
          inArray(
            messages.mailboxId,
            rows.map((r) => r.id),
          ),
          eq(messages.folder, "inbox"),
          eq(messages.isRead, false),
        ),
      )
      .groupBy(messages.mailboxId)
      .all();
    for (const row of counts) unreadByMailbox.set(row.mailboxId, row.unread);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    domain: r.domain,
    address: `${r.name}@${r.domain}`,
    role: r.role,
    unread: unreadByMailbox.get(r.id) ?? 0,
    displayName: r.displayName,
    signature: r.signature,
  }));
}

export function parseFolder(raw: string | undefined): MessageFolder {
  const folder = raw ?? "inbox";
  if (!(MESSAGE_FOLDERS as readonly string[]).includes(folder)) {
    throw new ServiceError(400, `Unknown folder: ${folder}`);
  }
  return folder as MessageFolder;
}

/** "<epochSeconds>.<id>" keyset cursor → the "older than" condition. */
function dateCursorCondition(cursor: string) {
  const dot = cursor.indexOf(".");
  const cursorDate = Number(cursor.slice(0, dot));
  const cursorId = cursor.slice(dot + 1);
  if (dot < 1 || !Number.isFinite(cursorDate) || !cursorId) {
    throw new ServiceError(400, "Malformed cursor");
  }
  const boundary = new Date(cursorDate * 1000);
  return or(
    lt(messages.date, boundary),
    and(eq(messages.date, boundary), lt(messages.id, cursorId)),
  )!;
}

export interface ListMessagesInput {
  mailboxId: string;
  folder?: string;
  labelId?: string;
  cursor?: string;
  limit?: unknown;
}

/**
 * One folder of a mailbox, newest first. Keyset cursor "<epochSeconds>.<id>"
 * so pages stay stable while new mail arrives. Optional label filter (MAIL-16):
 * the label must belong to this mailbox (multi-domain invariant).
 */
export async function listMessages(ctx: ServiceContext, input: ListMessagesInput) {
  const { db } = ctx;
  await requireMailbox(ctx, input.mailboxId);
  const folder = parseFolder(input.folder);
  const limit = pageSize(input.limit);

  const labelId = input.labelId;
  if (labelId) {
    const label = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.id, labelId), eq(labels.mailboxId, input.mailboxId)))
      .get();
    if (!label) throw new ServiceError(404, "Label not found");
  }

  const conditions = [
    eq(messages.mailboxId, input.mailboxId),
    eq(messages.folder, folder),
  ];
  if (input.cursor) conditions.push(dateCursorCondition(input.cursor));

  // With a label filter, inner-join the join table so only tagged messages come
  // back; the select shape is normalized to `{ message }` either way.
  const page = labelId
    ? await db
        .select({ message: messages })
        .from(messages)
        .innerJoin(
          messageLabels,
          and(
            eq(messageLabels.messageId, messages.id),
            eq(messageLabels.labelId, labelId),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(messages.date), desc(messages.id))
        .limit(limit + 1)
        .all()
    : (
        await db
          .select()
          .from(messages)
          .where(and(...conditions))
          .orderBy(desc(messages.date), desc(messages.id))
          .limit(limit + 1)
          .all()
      ).map((message) => ({ message }));

  const items = page.slice(0, limit);
  const last = items[items.length - 1]?.message;
  const nextCursor =
    page.length > limit && last
      ? `${Math.floor(last.date.getTime() / 1000)}.${last.id}`
      : null;

  const labelsByMsg = await labelsByMessage(
    db,
    items.map((row) => row.message.id),
  );
  return {
    messages: items.map((row) =>
      messageListItem(row.message, labelsByMsg.get(row.message.id) ?? []),
    ),
    nextCursor,
  };
}

/**
 * FTS5 search across one mailbox (all folders). The query is tokenized and
 * quoted so user input can never hit FTS5 syntax errors; the last token
 * matches by prefix for as-you-type friendliness.
 */
export async function searchMessages(
  ctx: ServiceContext,
  input: { mailboxId: string; q: string; limit?: unknown },
) {
  const { db } = ctx;
  await requireMailbox(ctx, input.mailboxId);
  const q = input.q.trim();
  if (!q) throw new ServiceError(400, "q is required");
  const ftsQuery = q
    .split(/\s+/)
    .map((token, i, all) => {
      const quoted = `"${token.replaceAll('"', '""')}"`;
      return i === all.length - 1 ? `${quoted}*` : quoted;
    })
    .join(" ");
  const limit = pageSize(input.limit);

  const matched = await ctx.env.DB.prepare(
    `SELECT m.id FROM messages_fts f
     JOIN messages m ON m.rowid = f.rowid
     WHERE messages_fts MATCH ?1 AND m.mailbox_id = ?2
     ORDER BY rank LIMIT ?3`,
  )
    .bind(ftsQuery, input.mailboxId, limit)
    .all<{ id: string }>();

  const ids = matched.results.map((r) => r.id);
  if (ids.length === 0) return { messages: [] };

  const rows = await db
    .select()
    .from(messages)
    .where(inArray(messages.id, ids))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const labelsByMsg = await labelsByMessage(db, ids);
  return {
    messages: ids
      .map((id) => byId.get(id))
      .filter((r) => r !== undefined)
      .map((r) => messageListItem(r, labelsByMsg.get(r.id) ?? [])),
  };
}

/** One message with its attachments and labels; 404 outside memberships. */
export async function getMessage(ctx: ServiceContext, messageId: string) {
  const { db } = ctx;
  const message = await getAccessibleMessage(db, ctx.userId, messageId);
  if (!message) throw new ServiceError(404, "Message not found");
  const attachmentRows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.messageId, message.id))
    .all();
  const labelsForMessage =
    (await labelsByMessage(db, [message.id])).get(message.id) ?? [];
  return { message, attachments: attachmentRows, labels: labelsForMessage };
}

export interface ParsedRaw {
  html: string | null;
  text: string | null;
  headers: {
    from: string;
    to: string[];
    cc: string[];
    replyTo: string[];
    date: string | null;
    messageId: string | null;
    inReplyTo: string | null;
    references: string | null;
  } | null;
}

function addressList(
  list: { address?: string; group?: { address?: string }[] }[] | undefined,
): string[] {
  const out: string[] = [];
  for (const entry of list ?? []) {
    if (entry.address) out.push(entry.address);
    for (const member of entry.group ?? []) {
      if (member.address) out.push(member.address);
    }
  }
  return out;
}

/**
 * Parse a message's immutable raw .eml from R2 (bodies + a header subset).
 * Returns nulls when the blob is missing or the MIME is malformed; callers
 * fall back to the indexed body text.
 */
export async function parseRawMessage(
  env: Env,
  r2Key: string,
): Promise<ParsedRaw | null> {
  const object = await env.MAIL_BUCKET.get(r2Key);
  if (!object) return null;
  try {
    const email = await PostalMime.parse(await object.arrayBuffer());
    return {
      html: email.html ?? null,
      text: email.text ?? null,
      headers: {
        from: email.from?.address ?? "",
        to: addressList(email.to),
        cc: addressList(email.cc),
        replyTo: addressList(email.replyTo),
        date: email.date ?? null,
        messageId: email.messageId ?? null,
        inReplyTo: email.inReplyTo ?? null,
        references: email.references ?? null,
      },
    };
  } catch {
    return { html: null, text: null, headers: null };
  }
}

/** Whole thread, oldest first, each message with attachments and labels. */
export async function getThread(ctx: ServiceContext, threadId: string) {
  const { db } = ctx;
  const thread = await getAccessibleThread(db, ctx.userId, threadId);
  if (!thread) throw new ServiceError(404, "Thread not found");

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, thread.id))
    .orderBy(asc(messages.date), asc(messages.id))
    .all();

  const attachmentRows =
    rows.length > 0
      ? await db
          .select()
          .from(attachments)
          .where(
            inArray(
              attachments.messageId,
              rows.map((m) => m.id),
            ),
          )
          .all()
      : [];
  const byMessage = new Map<string, (typeof attachmentRows)[number][]>();
  for (const a of attachmentRows) {
    const list = byMessage.get(a.messageId) ?? [];
    list.push(a);
    byMessage.set(a.messageId, list);
  }
  const labelsByMsg = await labelsByMessage(
    db,
    rows.map((m) => m.id),
  );

  return {
    thread: {
      id: thread.id,
      mailboxId: thread.mailboxId,
      messageCount: thread.messageCount,
      lastMessageAt: thread.lastMessageAt.toISOString(),
    },
    messages: rows.map((m) =>
      messageDetail(m, byMessage.get(m.id) ?? [], labelsByMsg.get(m.id) ?? []),
    ),
  };
}

/** "<createdAtEpochSeconds>.<id>" — an ingest-order position for polling. */
function encodePollCursor(createdAt: number, id: string): string {
  return `${createdAt}.${id}`;
}

function decodePollCursor(cursor: string): { createdAt: number; id: string } {
  const dot = cursor.indexOf(".");
  const createdAt = Number(cursor.slice(0, dot));
  const id = cursor.slice(dot + 1);
  if (dot < 1 || !Number.isInteger(createdAt) || createdAt < 0) {
    throw new ServiceError(400, "Malformed cursor");
  }
  return { createdAt, id };
}

/**
 * New mail since a cursor, in ingest order (created_at, id) — not by the
 * sender-controlled Date header. Without `since`, returns no messages and a
 * cursor for "now", so a monitor starts clean. Scoped to the caller's
 * memberships (optionally one mailbox). Returns `nextCursor` to pass back;
 * `hasMore` when a full page came back.
 */
export async function pollNewMessages(
  ctx: ServiceContext,
  input: { since?: string; mailboxId?: string; limit?: unknown },
) {
  const { db } = ctx;
  if (input.mailboxId) await requireMailbox(ctx, input.mailboxId);

  const memberJoin = and(
    eq(mailboxMembers.mailboxId, messages.mailboxId),
    eq(mailboxMembers.userId, ctx.userId),
  );
  const scope = input.mailboxId
    ? [eq(messages.mailboxId, input.mailboxId)]
    : [];

  if (!input.since) {
    const latest = await db
      .select({ createdAt: messages.createdAt, id: messages.id })
      .from(messages)
      .innerJoin(mailboxMembers, memberJoin)
      .where(scope.length ? and(...scope) : undefined)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1)
      .get();
    const cursor = latest
      ? encodePollCursor(Math.floor(latest.createdAt.getTime() / 1000), latest.id)
      : encodePollCursor(Math.floor(Date.now() / 1000), "");
    return { messages: [], nextCursor: cursor, hasMore: false };
  }

  const { createdAt, id } = decodePollCursor(input.since);
  const boundary = new Date(createdAt * 1000);
  const limit = pageSize(input.limit);
  const rows = await db
    .select({
      message: messages,
      mailboxName: mailboxes.name,
      domainName: domains.name,
    })
    .from(messages)
    .innerJoin(mailboxMembers, memberJoin)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(
      and(
        ...scope,
        or(
          gt(messages.createdAt, boundary),
          and(eq(messages.createdAt, boundary), gt(messages.id, id)),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit)
    .all();

  const last = rows[rows.length - 1]?.message;
  const nextCursor = last
    ? encodePollCursor(Math.floor(last.createdAt.getTime() / 1000), last.id)
    : input.since;
  const labelsByMsg = await labelsByMessage(
    db,
    rows.map((r) => r.message.id),
  );
  return {
    messages: rows.map((r) => ({
      ...messageListItem(r.message, labelsByMsg.get(r.message.id) ?? []),
      mailboxId: r.message.mailboxId,
      mailboxAddress: `${r.mailboxName}@${r.domainName}`,
      receivedAt: r.message.createdAt.toISOString(),
    })),
    nextCursor,
    hasMore: rows.length === limit,
  };
}

export const AGENT_BODY_LIMIT = 100 * 1024;

function truncate(value: string, limit: number) {
  return value.length > limit
    ? { value: value.slice(0, limit), truncated: true }
    : { value, truncated: false };
}

/**
 * A message shaped for agents: plain text by default (from the raw .eml, else
 * the indexed body), truncated at 100 KB, a header subset, attachment metadata
 * and labels. HTML only on request, and labelled untrusted — inbound mail is
 * hostile input and may carry prompt injection.
 */
export async function getMessageForAgent(
  ctx: ServiceContext,
  messageId: string,
  opts: { includeHtml?: boolean } = {},
) {
  const found = await getMessage(ctx, messageId);
  const m = found.message;
  const parsed = await parseRawMessage(ctx.env, m.r2Key);
  const text = truncate(parsed?.text ?? m.bodyText, AGENT_BODY_LIMIT);
  const detail = messageDetail(m, found.attachments, found.labels);
  const { bodyText: _omit, ...rest } = detail;
  const html =
    opts.includeHtml && parsed?.html
      ? truncate(parsed.html, AGENT_BODY_LIMIT)
      : null;
  return {
    ...rest,
    headers: parsed?.headers ?? null,
    text: text.value,
    truncated: text.truncated,
    ...(html
      ? { untrustedHtml: html.value, htmlTruncated: html.truncated }
      : {}),
  };
}
