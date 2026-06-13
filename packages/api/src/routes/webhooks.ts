import { messages, verifySvixSignature } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { AppEnv } from "../lib/context";

// Resend bounce/complaint webhooks (DESIGN.md §5 "Send"). This endpoint is
// public — Resend has no session — and is authenticated by the Svix signature
// Resend sends. We flag the affected outbound message (matched by the provider
// id we stored at send time) so the webmail can surface the problem.
export const webhookRoutes = new Hono<AppEnv>();

const STATUS_BY_EVENT: Record<string, string> = {
  "email.bounced": "bounced",
  "email.complained": "complained",
};

webhookRoutes.post("/resend", async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error("RESEND_WEBHOOK_SECRET is not set; rejecting webhook");
    return c.json({ error: "Webhooks are not configured" }, 503);
  }

  // Signature is over the exact bytes, so verify before parsing.
  const payload = await c.req.text();
  const valid = verifySvixSignature(
    secret,
    {
      id: c.req.header("svix-id") ?? "",
      timestamp: c.req.header("svix-timestamp") ?? "",
      signature: c.req.header("svix-signature") ?? "",
    },
    payload,
  );
  if (!valid) return c.json({ error: "Invalid signature" }, 401);

  let event: { type?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(payload);
  } catch {
    return c.json({ error: "Malformed payload" }, 400);
  }

  const status = event.type ? STATUS_BY_EVENT[event.type] : undefined;
  const emailId = event.data?.email_id;
  if (status && emailId) {
    const db = drizzle(c.env.DB);
    const result = await db
      .update(messages)
      .set({ deliveryStatus: status })
      .where(eq(messages.providerMessageId, emailId));
    // A matched-nothing event usually means the id is from another deployment
    // or the Sent copy was lost; log it so it isn't silently dropped.
    if (result.meta.changes === 0) {
      console.warn(`Resend ${event.type} for unknown email_id ${emailId}`);
    }
  }

  // Acknowledge every authenticated event (even ones we ignore) so Resend does
  // not retry.
  return c.json({ ok: true });
});
