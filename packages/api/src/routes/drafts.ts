import { Hono } from "hono";
import type { AppEnv } from "../lib/context";
import { sessionServiceContext } from "../lib/service-context";
import type { ReplyMode } from "../services/compose";
import {
  createDraft,
  createReplyDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  sendDraft,
  updateDraft,
} from "../services/drafts";

// Webmail draft routes (Phase 8): session + CSRF, same service as the agent
// /api/v1/drafts routes, so a draft an agent writes shows up here and vice
// versa. Drafts are author-private (services/drafts.ts).

export const draftRoutes = new Hono<AppEnv>();

type Body = Record<string, unknown>;
const jsonBody = async (req: { json: () => Promise<unknown> }) =>
  ((await req.json().catch(() => null)) ?? {}) as Body;

draftRoutes.get("/", async (c) => {
  return c.json({
    drafts: await listDrafts(sessionServiceContext(c), {
      mailboxId: c.req.query("mailboxId") || undefined,
    }),
  });
});

draftRoutes.post("/", async (c) => {
  const draft = await createDraft(sessionServiceContext(c), await jsonBody(c.req));
  return c.json({ draft }, 201);
});

// Server-built reply / reply-all / forward draft of a message.
draftRoutes.post("/from-message/:messageId", async (c) => {
  const body = await jsonBody(c.req);
  const draft = await createReplyDraft(
    sessionServiceContext(c),
    c.req.param("messageId"),
    (typeof body.mode === "string" ? body.mode : "reply") as ReplyMode,
    {
      text: typeof body.text === "string" ? body.text : undefined,
      html: typeof body.html === "string" ? body.html : undefined,
    },
  );
  return c.json({ draft }, 201);
});

draftRoutes.get("/:id", async (c) => {
  return c.json({ draft: await getDraft(sessionServiceContext(c), c.req.param("id")) });
});

draftRoutes.patch("/:id", async (c) => {
  const draft = await updateDraft(
    sessionServiceContext(c),
    c.req.param("id"),
    await jsonBody(c.req),
  );
  return c.json({ draft });
});

draftRoutes.delete("/:id", async (c) => {
  await deleteDraft(sessionServiceContext(c), c.req.param("id"));
  return c.json({ ok: true });
});

// Send the draft (webmail sends are not capped) and delete it.
draftRoutes.post("/:id/send", async (c) => {
  const body = await jsonBody(c.req);
  const result = await sendDraft(sessionServiceContext(c), c.req.param("id"), {
    version: body.version,
  });
  return c.json(result, 201);
});
