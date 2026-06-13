import {
  domains,
  mailboxes,
  mailboxMembers,
  MESSAGE_FOLDERS,
  messages,
  type MessageFolder,
} from "@mailbase/shared";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { hasMailboxAccess } from "../lib/access";
import type { AppEnv } from "../lib/context";
import { messageListItem } from "../lib/serialize";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export const mailboxRoutes = new Hono<AppEnv>();

// All mailboxes the user is a member of, with inbox unread counts.
mailboxRoutes.get("/", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");

  const rows = await db
    .select({ id: mailboxes.id, name: mailboxes.name, domain: domains.name })
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
      unread: unreadByMailbox.get(r.id) ?? 0,
    })),
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
