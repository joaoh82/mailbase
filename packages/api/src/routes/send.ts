import { identities, sanitizeOutboundHtml } from "@mailbase/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { AppEnv } from "../lib/context";
import { sessionServiceContext } from "../lib/service-context";
import {
  listIdentities,
  MAX_ATTACHMENT_BYTES,
  sendMessage,
  stageUpload,
} from "../services/send";

export const sendRoutes = new Hono<AppEnv>();

// The identities a user may send as (who-may-send-as-what, DESIGN.md §4). Each
// carries its own signature plus the owning mailbox's default, so the composer
// can resolve which one to insert at compose time (MAIL-4).
sendRoutes.get("/identities", async (c) => {
  return c.json({ identities: await listIdentities(sessionServiceContext(c)) });
});

// Update the signature for one of the caller's own send-as identities. The
// where-clause is scoped to this user, so an identity that isn't theirs simply
// matches no row (404). The HTML is sanitized to the outbound allowlist before
// it is stored — we never trust the client (DESIGN.md §5/§6).
sendRoutes.patch("/identities/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (typeof body?.signature !== "string") {
    return c.json({ error: "signature must be a string" }, 400);
  }
  const signature = sanitizeOutboundHtml(body.signature);

  const result = await db
    .update(identities)
    .set({ signature })
    .where(and(eq(identities.id, id), eq(identities.userId, user.id)));
  if (result.meta.changes === 0) {
    return c.json({ error: "Identity not found" }, 404);
  }
  return c.json({ signature });
});

// Stage one attachment in R2 before sending. Returns an opaque uploadId the
// compose form passes back to POST / (or attaches to a draft). Objects live
// under the user's prefix, so a user can only ever reference their own uploads.
sendRoutes.post("/uploads", async (c) => {
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "Expected a multipart 'file' field" }, 400);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "Attachment exceeds the 20 MB limit" }, 413);
  }
  return c.json(
    await stageUpload(sessionServiceContext(c), {
      filename: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    }),
  );
});

// Send a message (services/send.ts): identity check, sanitize, provider send,
// Sent copy + threading. Webmail sends are not counted against any cap.
sendRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const result = await sendMessage(sessionServiceContext(c), sendInputFromBody(body));
  return c.json(result, 201);
});

/** Normalizes a JSON send body (shared by the session and agent routes). */
export function sendInputFromBody(body: Record<string, unknown> | null) {
  return {
    identityId: typeof body?.identityId === "string" ? body.identityId : "",
    to: body?.to,
    cc: body?.cc,
    bcc: body?.bcc,
    subject: typeof body?.subject === "string" ? body.subject : "",
    html: typeof body?.html === "string" ? body.html : "",
    text: typeof body?.text === "string" ? body.text : "",
    inReplyTo:
      typeof body?.inReplyTo === "string" && body.inReplyTo
        ? body.inReplyTo
        : null,
    uploadIds: Array.isArray(body?.uploadIds)
      ? body.uploadIds.filter((v): v is string => typeof v === "string")
      : [],
  };
}
