import {
  addresses,
  domains,
  identities,
  mailboxes,
  MAILBOX_ROLES,
  mailboxMembers,
  type MailboxRole,
  MESSAGE_FOLDERS,
  messages,
  type MessageFolder,
  sanitizeOutboundHtml,
  users,
} from "@mailbase/shared";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { hasMailboxAccess } from "../lib/access";
import type { AppEnv } from "../lib/context";
import {
  canManageMailbox,
  getMailboxRole,
  grantMailboxMembership,
} from "../lib/membership";
import { messageListItem } from "../lib/serialize";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export const mailboxRoutes = new Hono<AppEnv>();

// All mailboxes the user is a member of, with inbox unread counts.
mailboxRoutes.get("/", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");

  const rows = await db
    .select({
      id: mailboxes.id,
      name: mailboxes.name,
      domain: domains.name,
      role: mailboxMembers.role,
      signature: mailboxes.signature,
    })
    .from(mailboxMembers)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxMembers.mailboxId))
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(eq(mailboxMembers.userId, user.id))
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

  return c.json({
    mailboxes: rows.map((r) => ({
      id: r.id,
      name: r.name,
      domain: r.domain,
      address: `${r.name}@${r.domain}`,
      role: r.role,
      unread: unreadByMailbox.get(r.id) ?? 0,
      signature: r.signature,
    })),
  });
});

// Cheap "anything changed?" probe for the live-update poll (MAIL-14). Returns
// one row per mailbox the user belongs to — each with `latestAt` (the max
// message `created_at`, epoch seconds, across every folder) and the inbox
// `unread` count — so the SPA can compare successive responses and only refetch
// the active view when the signal moves. Membership-scoped like every other
// read (multi-domain invariant): a user is never told about mailboxes they
// can't access. One small grouped query per tick keeps idle cost bounded.
mailboxRoutes.get("/changes", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");

  const memberships = await db
    .select({ id: mailboxMembers.mailboxId })
    .from(mailboxMembers)
    .where(eq(mailboxMembers.userId, user.id))
    .all();
  const ids = memberships.map((m) => m.id);
  if (ids.length === 0) return c.json({ mailboxes: [] });

  const rows = await db
    .select({
      mailboxId: messages.mailboxId,
      latestAt: sql<number | null>`max(${messages.createdAt})`,
      unread: sql<number>`sum(case when ${messages.folder} = 'inbox' and ${messages.isRead} = 0 then 1 else 0 end)`,
    })
    .from(messages)
    .where(inArray(messages.mailboxId, ids))
    .groupBy(messages.mailboxId)
    .all();
  const byId = new Map(rows.map((r) => [r.mailboxId, r]));

  // Always emit a row per membership (even mailboxes with no mail yet) so the
  // client's change signature is over a stable set.
  return c.json({
    mailboxes: ids.map((id) => {
      const row = byId.get(id);
      return {
        id,
        latestAt: row?.latestAt ?? null,
        unread: Number(row?.unread ?? 0),
      };
    }),
  });
});

// Update a mailbox's default signature (MAIL-4). Any member of the mailbox may
// edit the shared default; the HTML is sanitized to the outbound allowlist
// before it is stored. Reads/writes are scoped by mailbox membership, never by
// assuming a single mailbox (multi-domain invariant).
mailboxRoutes.patch("/:mailboxId/signature", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const mailboxId = c.req.param("mailboxId");
  if (!(await hasMailboxAccess(db, user.id, mailboxId))) {
    return c.json({ error: "Mailbox not found" }, 404);
  }

  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (typeof body?.signature !== "string") {
    return c.json({ error: "signature must be a string" }, 400);
  }
  const signature = sanitizeOutboundHtml(body.signature);

  await db
    .update(mailboxes)
    .set({ signature })
    .where(eq(mailboxes.id, mailboxId));
  return c.json({ signature });
});

// Unified "all inboxes" view (Phase 5): one folder across every mailbox the
// user belongs to, newest first, with each message tagged by its mailbox so the
// SPA can show where it landed. Same keyset cursor as the per-mailbox list.
// Registered before "/:mailboxId/messages" so "all" is not read as an id.
mailboxRoutes.get("/all/messages", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");

  const folderParam = c.req.query("folder") ?? "inbox";
  if (!(MESSAGE_FOLDERS as readonly string[]).includes(folderParam)) {
    return c.json({ error: `Unknown folder: ${folderParam}` }, 400);
  }
  const folder = folderParam as MessageFolder;

  const limit = Math.min(
    Math.max(Number(c.req.query("limit")) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );

  // Scope to the user's mailbox memberships via an inner join — nothing outside
  // them is reachable (multi-domain invariant).
  const conditions = [
    eq(mailboxMembers.userId, user.id),
    eq(messages.folder, folder),
  ];
  const cursorParam = c.req.query("cursor");
  if (cursorParam) {
    const dot = cursorParam.indexOf(".");
    const cursorDate = Number(cursorParam.slice(0, dot));
    const cursorId = cursorParam.slice(dot + 1);
    if (dot < 1 || !Number.isFinite(cursorDate) || !cursorId) {
      return c.json({ error: "Malformed cursor" }, 400);
    }
    const boundary = new Date(cursorDate * 1000);
    conditions.push(
      or(
        lt(messages.date, boundary),
        and(eq(messages.date, boundary), lt(messages.id, cursorId)),
      )!,
    );
  }

  const page = await db
    .select({
      message: messages,
      mailboxName: mailboxes.name,
      domainName: domains.name,
    })
    .from(messages)
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.mailboxId, messages.mailboxId),
        eq(mailboxMembers.userId, user.id),
      ),
    )
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(and(...conditions))
    .orderBy(desc(messages.date), desc(messages.id))
    .limit(limit + 1)
    .all();

  const items = page.slice(0, limit);
  const last = items[items.length - 1]?.message;
  const nextCursor =
    page.length > limit && last
      ? `${Math.floor(last.date.getTime() / 1000)}.${last.id}`
      : null;

  return c.json({
    messages: items.map((row) => ({
      ...messageListItem(row.message),
      mailboxId: row.message.mailboxId,
      mailboxAddress: `${row.mailboxName}@${row.domainName}`,
    })),
    nextCursor,
  });
});

// Paginated message list for one folder, newest first. Keyset cursor
// "<epochSeconds>.<id>" so pages stay stable while new mail arrives.
mailboxRoutes.get("/:mailboxId/messages", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const mailboxId = c.req.param("mailboxId");
  if (!(await hasMailboxAccess(db, user.id, mailboxId))) {
    return c.json({ error: "Mailbox not found" }, 404);
  }

  const folderParam = c.req.query("folder") ?? "inbox";
  if (!(MESSAGE_FOLDERS as readonly string[]).includes(folderParam)) {
    return c.json({ error: `Unknown folder: ${folderParam}` }, 400);
  }
  const folder = folderParam as MessageFolder;

  const limit = Math.min(
    Math.max(Number(c.req.query("limit")) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );

  const conditions = [
    eq(messages.mailboxId, mailboxId),
    eq(messages.folder, folder),
  ];
  const cursorParam = c.req.query("cursor");
  if (cursorParam) {
    const dot = cursorParam.indexOf(".");
    const cursorDate = Number(cursorParam.slice(0, dot));
    const cursorId = cursorParam.slice(dot + 1);
    if (dot < 1 || !Number.isFinite(cursorDate) || !cursorId) {
      return c.json({ error: "Malformed cursor" }, 400);
    }
    const boundary = new Date(cursorDate * 1000);
    conditions.push(
      or(
        lt(messages.date, boundary),
        and(eq(messages.date, boundary), lt(messages.id, cursorId)),
      )!,
    );
  }

  const page = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.date), desc(messages.id))
    .limit(limit + 1)
    .all();

  const items = page.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    page.length > limit && last
      ? `${Math.floor(last.date.getTime() / 1000)}.${last.id}`
      : null;

  return c.json({ messages: items.map(messageListItem), nextCursor });
});

// FTS5 search across the mailbox (all folders). The query is tokenized and
// quoted so user input can never hit FTS5 syntax errors; the last token
// matches by prefix for as-you-type friendliness.
mailboxRoutes.get("/:mailboxId/search", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const mailboxId = c.req.param("mailboxId");
  if (!(await hasMailboxAccess(db, user.id, mailboxId))) {
    return c.json({ error: "Mailbox not found" }, 404);
  }

  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ error: "q is required" }, 400);
  const ftsQuery = q
    .split(/\s+/)
    .map((token, i, all) => {
      const quoted = `"${token.replaceAll('"', '""')}"`;
      return i === all.length - 1 ? `${quoted}*` : quoted;
    })
    .join(" ");

  const limit = Math.min(
    Math.max(Number(c.req.query("limit")) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );

  const matched = await c.env.DB.prepare(
    `SELECT m.id FROM messages_fts f
     JOIN messages m ON m.rowid = f.rowid
     WHERE messages_fts MATCH ?1 AND m.mailbox_id = ?2
     ORDER BY rank LIMIT ?3`,
  )
    .bind(ftsQuery, mailboxId, limit)
    .all<{ id: string }>();

  const ids = matched.results.map((r) => r.id);
  if (ids.length === 0) return c.json({ messages: [] });

  const rows = await db
    .select()
    .from(messages)
    .where(inArray(messages.id, ids))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return c.json({
    messages: ids
      .map((id) => byId.get(id))
      .filter((r) => r !== undefined)
      .map(messageListItem),
  });
});

const MEMBER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Who shares a mailbox. Any member may see the roster of a shared inbox.
mailboxRoutes.get("/:mailboxId/members", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const mailboxId = c.req.param("mailboxId");
  if (!(await hasMailboxAccess(db, user.id, mailboxId))) {
    return c.json({ error: "Mailbox not found" }, 404);
  }

  const rows = await db
    .select({
      userId: users.id,
      email: users.emailLogin,
      displayName: users.displayName,
      role: mailboxMembers.role,
    })
    .from(mailboxMembers)
    .innerJoin(users, eq(users.id, mailboxMembers.userId))
    .where(eq(mailboxMembers.mailboxId, mailboxId))
    .orderBy(users.emailLogin)
    .all();

  return c.json({ members: rows });
});

// Add an *existing* account to a shared mailbox (owner/admin only); brand-new
// logins come in through the invite flow. Grants send-as identities too.
mailboxRoutes.post("/:mailboxId/members", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const mailboxId = c.req.param("mailboxId");
  if (!(await canManageMailbox(db, user, mailboxId))) {
    return c.json({ error: "You cannot manage this mailbox" }, 403);
  }

  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const roleInput = typeof body?.role === "string" ? body.role : "member";
  if (!MEMBER_EMAIL_RE.test(email)) {
    return c.json({ error: "A valid email is required" }, 400);
  }
  if (!(MAILBOX_ROLES as readonly string[]).includes(roleInput)) {
    return c.json(
      { error: `role must be one of: ${MAILBOX_ROLES.join(", ")}` },
      400,
    );
  }

  const target = await db
    .select()
    .from(users)
    .where(eq(users.emailLogin, email))
    .get();
  if (!target) {
    return c.json(
      { error: "No account with that email; invite them instead" },
      404,
    );
  }

  await grantMailboxMembership(
    db,
    target.id,
    mailboxId,
    roleInput as MailboxRole,
    target.displayName,
  );
  return c.json({ ok: true }, 201);
});

// Remove a member (owner/admin only). The last owner cannot be removed, so a
// shared mailbox always keeps someone who can manage it. Their send-as
// identities for this mailbox's addresses are revoked at the same time.
mailboxRoutes.delete("/:mailboxId/members/:userId", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const mailboxId = c.req.param("mailboxId");
  if (!(await canManageMailbox(db, user, mailboxId))) {
    return c.json({ error: "You cannot manage this mailbox" }, 403);
  }

  const targetUserId = c.req.param("userId");
  const targetRole = await getMailboxRole(db, targetUserId, mailboxId);
  if (!targetRole) return c.json({ error: "Member not found" }, 404);

  if (targetRole === "owner") {
    const owners = await db
      .select({ count: sql<number>`count(*)` })
      .from(mailboxMembers)
      .where(
        and(
          eq(mailboxMembers.mailboxId, mailboxId),
          eq(mailboxMembers.role, "owner"),
        ),
      )
      .get();
    if ((owners?.count ?? 0) <= 1) {
      return c.json({ error: "Cannot remove the last owner" }, 400);
    }
  }

  const mailboxAddresses = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(eq(addresses.mailboxId, mailboxId))
    .all();
  if (mailboxAddresses.length > 0) {
    await db.delete(identities).where(
      and(
        eq(identities.userId, targetUserId),
        inArray(
          identities.addressId,
          mailboxAddresses.map((a) => a.id),
        ),
      ),
    );
  }
  await db
    .delete(mailboxMembers)
    .where(
      and(
        eq(mailboxMembers.mailboxId, mailboxId),
        eq(mailboxMembers.userId, targetUserId),
      ),
    );

  return c.json({ ok: true });
});
