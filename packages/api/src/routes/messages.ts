import { eventAttendees, events } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { getAccessibleMessage } from "../lib/access";
import type { AppEnv } from "../lib/context";
import { calendarEvent, messageDetail } from "../lib/serialize";
import { sessionServiceContext } from "../lib/service-context";
import { getMessage, parseRawMessage } from "../services/mail-query";
import {
  addMessageLabel,
  attachmentUrl,
  moveMessage,
  removeMessageLabel,
  setMessageFlag,
} from "../services/message-actions";

export const messageRoutes = new Hono<AppEnv>();

messageRoutes.get("/:id", async (c) => {
  const found = await getMessage(sessionServiceContext(c), c.req.param("id"));
  return c.json({
    message: messageDetail(found.message, found.attachments, found.labels),
  });
});

// The calendar event carried by this message, if it's a meeting invite (MAIL-29),
// for the reading-pane RSVP card. Null when the message has no linked event.
// Access is gated by getAccessibleMessage; the event shares the message's mailbox.
messageRoutes.get("/:id/event", async (c) => {
  const db = drizzle(c.env.DB);
  const message = await getAccessibleMessage(
    db,
    c.get("user").id,
    c.req.param("id"),
  );
  if (!message) return c.json({ error: "Message not found" }, 404);

  const event = await db
    .select()
    .from(events)
    .where(eq(events.messageId, message.id))
    .get();
  if (!event) return c.json({ event: null });

  const attendees = await db
    .select()
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, event.id))
    .all();
  return c.json({ event: calendarEvent(event, attendees) });
});

// Lazily parse the immutable raw .eml from R2 for the full body. D1 only
// holds plain text; HTML is served from here and rendered in the SPA's
// sandboxed iframe.
messageRoutes.get("/:id/full", async (c) => {
  const db = drizzle(c.env.DB);
  const message = await getAccessibleMessage(
    db,
    c.get("user").id,
    c.req.param("id"),
  );
  if (!message) return c.json({ error: "Message not found" }, 404);

  const parsed = await parseRawMessage(c.env, message.r2Key);
  if (!parsed) return c.json({ error: "Raw message missing from R2" }, 404);
  // Malformed MIME parses to nulls: fall back to the indexed body text.
  return c.json({ html: parsed.html, text: parsed.text ?? message.bodyText });
});

messageRoutes.get("/:id/raw", async (c) => {
  const db = drizzle(c.env.DB);
  const message = await getAccessibleMessage(
    db,
    c.get("user").id,
    c.req.param("id"),
  );
  if (!message) return c.json({ error: "Message not found" }, 404);

  const object = await c.env.MAIL_BUCKET.get(message.r2Key);
  if (!object) return c.json({ error: "Raw message missing from R2" }, 404);

  return new Response(object.body, {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${message.id}.eml"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

messageRoutes.post("/:id/read", async (c) => {
  const body = await c.req.json().catch(() => null);
  await setMessageFlag(
    sessionServiceContext(c),
    c.req.param("id"),
    "isRead",
    body?.isRead,
  );
  return c.json({ ok: true });
});

messageRoutes.post("/:id/star", async (c) => {
  const body = await c.req.json().catch(() => null);
  await setMessageFlag(
    sessionServiceContext(c),
    c.req.param("id"),
    "isStarred",
    body?.isStarred,
  );
  return c.json({ ok: true });
});

messageRoutes.post("/:id/move", async (c) => {
  const body = await c.req.json().catch(() => null);
  await moveMessage(sessionServiceContext(c), c.req.param("id"), body?.folder);
  return c.json({ ok: true });
});

// Apply a label to a message (idempotent); the label must be in the message's
// mailbox (services/message-actions.ts).
messageRoutes.put("/:id/labels/:labelId", async (c) => {
  await addMessageLabel(
    sessionServiceContext(c),
    c.req.param("id"),
    c.req.param("labelId"),
  );
  return c.json({ ok: true });
});

// Remove a label from a message. Idempotent: removing an absent label is a
// no-op success, so the UI can call it without first checking.
messageRoutes.delete("/:id/labels/:labelId", async (c) => {
  await removeMessageLabel(
    sessionServiceContext(c),
    c.req.param("id"),
    c.req.param("labelId"),
  );
  return c.json({ ok: true });
});

// Mint a signed, expiring download URL for one attachment of a message the
// user can read. The URL itself is then usable without a session. Relative for
// the SPA (same origin).
messageRoutes.get("/:id/attachments/:attachmentId/url", async (c) => {
  const { url, expiresAt } = await attachmentUrl(
    sessionServiceContext(c),
    c.req.param("id"),
    c.req.param("attachmentId"),
  );
  return c.json({ url, expiresAt });
});
