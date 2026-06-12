import { attachments, messages } from "@mailbase/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import PostalMime from "postal-mime";
import { getAccessibleMessage } from "../lib/access";
import {
  ATTACHMENT_URL_TTL_SECONDS,
  attachmentSignature,
  requireSigningKey,
} from "../lib/attachment-urls";
import type { AppEnv } from "../lib/context";
import { messageDetail } from "../lib/serialize";

const MOVE_TARGETS = ["inbox", "archive", "trash"] as const;
type MoveTarget = (typeof MOVE_TARGETS)[number];

export const messageRoutes = new Hono<AppEnv>();

messageRoutes.get("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const message = await getAccessibleMessage(
    db,
    c.get("user").id,
    c.req.param("id"),
  );
  if (!message) return c.json({ error: "Message not found" }, 404);

  const attachmentRows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.messageId, message.id))
    .all();
  return c.json({ message: messageDetail(message, attachmentRows) });
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

  const object = await c.env.MAIL_BUCKET.get(message.r2Key);
  if (!object) return c.json({ error: "Raw message missing from R2" }, 404);

  let html: string | null = null;
  let text: string | null = null;
  try {
    const email = await PostalMime.parse(await object.arrayBuffer());
    html = email.html ?? null;
    text = email.text ?? null;
  } catch {
    // Malformed MIME: fall back to the indexed body text below.
  }
  return c.json({ html, text: text ?? message.bodyText });
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
  return setMessageFlag(c, "isRead");
});

messageRoutes.post("/:id/star", async (c) => {
  return setMessageFlag(c, "isStarred");
});

async function setMessageFlag(
  c: Context<AppEnv>,
  flag: "isRead" | "isStarred",
) {
  const db = drizzle(c.env.DB);
  const message = await getAccessibleMessage(
    db,
    c.get("user").id,
    c.req.param("id") ?? "",
  );
  if (!message) return c.json({ error: "Message not found" }, 404);

  const body = await c.req.json().catch(() => null);
  const value = flag === "isRead" ? body?.isRead : body?.isStarred;
  if (typeof value !== "boolean") {
    return c.json(
      { error: `${flag === "isRead" ? "isRead" : "isStarred"} must be a boolean` },
      400,
    );
  }

  await db
    .update(messages)
    .set({ [flag]: value })
    .where(eq(messages.id, message.id));
  return c.json({ ok: true });
}

messageRoutes.post("/:id/move", async (c) => {
  const db = drizzle(c.env.DB);
  const message = await getAccessibleMessage(
    db,
    c.get("user").id,
    c.req.param("id"),
  );
  if (!message) return c.json({ error: "Message not found" }, 404);

  const body = await c.req.json().catch(() => null);
  const folder = body?.folder;
  if (!MOVE_TARGETS.includes(folder)) {
    return c.json(
      { error: `folder must be one of: ${MOVE_TARGETS.join(", ")}` },
      400,
    );
  }

  await db
    .update(messages)
    .set({ folder: folder as MoveTarget })
    .where(eq(messages.id, message.id));
  return c.json({ ok: true });
});

// Mint a signed, expiring download URL for one attachment of a message the
// user can read. The URL itself is then usable without a session.
messageRoutes.get("/:id/attachments/:attachmentId/url", async (c) => {
  const signingKey = requireSigningKey(c.env);
  const db = drizzle(c.env.DB);
  const message = await getAccessibleMessage(
    db,
    c.get("user").id,
    c.req.param("id"),
  );
  if (!message) return c.json({ error: "Message not found" }, 404);

  const attachment = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.id, c.req.param("attachmentId")),
        eq(attachments.messageId, message.id),
      ),
    )
    .get();
  if (!attachment) return c.json({ error: "Attachment not found" }, 404);

  const expiresAt =
    Math.floor(Date.now() / 1000) + ATTACHMENT_URL_TTL_SECONDS;
  const sig = attachmentSignature(signingKey, attachment.id, expiresAt);
  return c.json({
    url: `/api/attachments/${attachment.id}?expires=${expiresAt}&sig=${sig}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });
});
