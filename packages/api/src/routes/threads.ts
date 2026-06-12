import { attachments, messages } from "@mailbase/shared";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { getAccessibleThread } from "../lib/access";
import type { AppEnv } from "../lib/context";
import { messageDetail } from "../lib/serialize";

export const threadRoutes = new Hono<AppEnv>();

// Whole thread, oldest first, each message with its attachment list and
// indexed body text. HTML stays lazy via GET /api/messages/:id/full.
threadRoutes.get("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const thread = await getAccessibleThread(
    db,
    c.get("user").id,
    c.req.param("id"),
  );
  if (!thread) return c.json({ error: "Thread not found" }, 404);

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

  return c.json({
    thread: {
      id: thread.id,
      mailboxId: thread.mailboxId,
      messageCount: thread.messageCount,
      lastMessageAt: thread.lastMessageAt.toISOString(),
    },
    messages: rows.map((m) => messageDetail(m, byMessage.get(m.id) ?? [])),
  });
});
