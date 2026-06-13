import { attachments, constantTimeEqual } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import {
  attachmentSignature,
  requireSigningKey,
} from "../lib/attachment-urls";
import type { AppEnv } from "../lib/context";

export const attachmentRoutes = new Hono<AppEnv>();

// Signed download — no session. The HMAC signature minted by
// /api/messages/:id/attachments/:attachmentId/url is the authorization.
// Always Content-Disposition: attachment (DESIGN.md §6): attachments are
// downloads, never rendered in the webmail origin.
attachmentRoutes.get("/:id", async (c) => {
  const signingKey = requireSigningKey(c.env);
  const attachmentId = c.req.param("id");
  const expires = Number(c.req.query("expires"));
  const sig = c.req.query("sig") ?? "";
  if (!Number.isFinite(expires) || !sig) {
    return c.json({ error: "Missing signature" }, 403);
  }
  if (expires * 1000 <= Date.now()) {
    return c.json({ error: "Link expired" }, 403);
  }
  const expected = attachmentSignature(signingKey, attachmentId, expires);
  if (!constantTimeEqual(sig, expected)) {
    return c.json({ error: "Invalid signature" }, 403);
  }

  const db = drizzle(c.env.DB);
  const attachment = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();
  if (!attachment) return c.json({ error: "Attachment not found" }, 404);

  const object = await c.env.MAIL_BUCKET.get(attachment.r2Key);
  if (!object) return c.json({ error: "Attachment missing from R2" }, 404);

  const safeName = attachment.filename.replace(/[\r\n"\\]/g, "_");
  return new Response(object.body, {
    headers: {
      "Content-Type": attachment.mimeType || "application/octet-stream",
      "Content-Length": String(attachment.size),
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});
