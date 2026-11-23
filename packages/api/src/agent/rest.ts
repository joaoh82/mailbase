import { type Context, Hono } from "hono";
import { requireApiToken } from "../lib/api-token";
import type { AgentEnv } from "../lib/context";
import { sendInputFromBody } from "../routes/send";
import { getEvent, listEvents, rsvpEvent } from "../services/calendar";
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
import {
  getMessageForAgent,
  getThread,
  listMailboxes,
  listMessages,
  pollNewMessages,
  searchMessages,
} from "../services/mail-query";
import {
  addMessageLabel,
  attachmentUrl,
  createLabel,
  listLabels,
  moveMessage,
  removeMessageLabel,
  setMessageFlag,
} from "../services/message-actions";
import {
  listIdentities,
  MAX_ATTACHMENT_BYTES,
  sendMessage,
  stageUpload,
} from "../services/send";
import { agentContext } from "./context";

// Agent REST API (Phase 8): /api/v1/*, bearer token only (requireApiToken —
// cookies are ignored, so there is no CSRF surface). Thin wrappers over the
// same services as the webmail and the MCP tools; see docs/AGENT_API.md. The
// sub-app ends in a catch-all 404 so an unknown /v1 path never falls through
// to the session routes mounted after it.

export const v1Routes = new Hono<AgentEnv>();

type Body = Record<string, unknown>;
const jsonBody = async (req: { json: () => Promise<unknown> }) =>
  ((await req.json().catch(() => null)) ?? {}) as Body;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

v1Routes.use("*", requireApiToken);

v1Routes.get("/me", (c) => {
  const user = c.get("user");
  const token = c.get("apiToken");
  return c.json({
    user: { id: user.id, email: user.emailLogin, displayName: user.displayName },
    token: {
      id: token.id,
      name: token.name,
      rateLimitPerMinute: token.rateLimitPerMinute,
      dailySendCap: token.dailySendCap,
      expiresAt: token.expiresAt ? token.expiresAt.toISOString() : null,
    },
  });
});

v1Routes.get("/identities", async (c) => {
  const identities = await listIdentities(agentContext(c));
  return c.json({
    identities: identities.map((i) => ({
      id: i.id,
      address: i.address,
      displayName: i.mailboxDisplayName || i.displayName,
      mailboxId: i.mailboxId,
    })),
  });
});

// --- Reading ---------------------------------------------------------------

v1Routes.get("/mailboxes", async (c) => {
  return c.json({ mailboxes: await listMailboxes(agentContext(c)) });
});

v1Routes.get("/mailboxes/:id/labels", async (c) => {
  return c.json({ labels: await listLabels(agentContext(c), c.req.param("id")) });
});

v1Routes.post("/mailboxes/:id/labels", async (c) => {
  const body = await jsonBody(c.req);
  const label = await createLabel(agentContext(c), {
    mailboxId: c.req.param("id"),
    name: body.name,
    color: body.color,
  });
  return c.json({ label }, 201);
});

v1Routes.get("/mailboxes/:id/messages", async (c) => {
  return c.json(
    await listMessages(agentContext(c), {
      mailboxId: c.req.param("id"),
      folder: c.req.query("folder"),
      labelId: c.req.query("labelId"),
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    }),
  );
});

v1Routes.get("/mailboxes/:id/search", async (c) => {
  return c.json(
    await searchMessages(agentContext(c), {
      mailboxId: c.req.param("id"),
      q: c.req.query("q") ?? "",
      limit: c.req.query("limit"),
    }),
  );
});

// Poll for new mail in ingest order. Registered before /messages/:id so "new"
// is not read as an id.
v1Routes.get("/messages/new", async (c) => {
  return c.json(
    await pollNewMessages(agentContext(c), {
      since: c.req.query("since") || undefined,
      mailboxId: c.req.query("mailboxId") || undefined,
      limit: c.req.query("limit"),
    }),
  );
});

v1Routes.get("/messages/:id", async (c) => {
  const html = c.req.query("html");
  return c.json({
    message: await getMessageForAgent(agentContext(c), c.req.param("id"), {
      includeHtml: html === "1" || html === "true",
    }),
  });
});

v1Routes.get("/threads/:id", async (c) => {
  return c.json(await getThread(agentContext(c), c.req.param("id")));
});

v1Routes.get("/messages/:id/attachments/:aid/url", async (c) => {
  const ctx = agentContext(c);
  return c.json(
    await attachmentUrl(ctx, c.req.param("id"), c.req.param("aid"), ctx.origin),
  );
});

// --- Organizing ------------------------------------------------------------

v1Routes.post("/messages/:id/read", async (c) => {
  const body = await jsonBody(c.req);
  await setMessageFlag(agentContext(c), c.req.param("id"), "isRead", body.isRead ?? true);
  return c.json({ ok: true });
});

v1Routes.post("/messages/:id/star", async (c) => {
  const body = await jsonBody(c.req);
  await setMessageFlag(
    agentContext(c),
    c.req.param("id"),
    "isStarred",
    body.isStarred ?? true,
  );
  return c.json({ ok: true });
});

v1Routes.post("/messages/:id/move", async (c) => {
  const body = await jsonBody(c.req);
  await moveMessage(agentContext(c), c.req.param("id"), body.folder);
  return c.json({ ok: true });
});

v1Routes.put("/messages/:id/labels/:labelId", async (c) => {
  await addMessageLabel(agentContext(c), c.req.param("id"), c.req.param("labelId"));
  return c.json({ ok: true });
});

v1Routes.delete("/messages/:id/labels/:labelId", async (c) => {
  await removeMessageLabel(agentContext(c), c.req.param("id"), c.req.param("labelId"));
  return c.json({ ok: true });
});

// --- Drafts ----------------------------------------------------------------

v1Routes.get("/drafts", async (c) => {
  return c.json({
    drafts: await listDrafts(agentContext(c), {
      mailboxId: c.req.query("mailboxId") || undefined,
    }),
  });
});

v1Routes.post("/drafts", async (c) => {
  return c.json({ draft: await createDraft(agentContext(c), await jsonBody(c.req)) }, 201);
});

v1Routes.post("/messages/:id/draft-reply", async (c) => {
  const body = await jsonBody(c.req);
  const draft = await createReplyDraft(
    agentContext(c),
    c.req.param("id"),
    (str(body.mode) ?? "reply") as ReplyMode,
    { text: str(body.text), html: str(body.html) },
  );
  return c.json({ draft }, 201);
});

v1Routes.get("/drafts/:id", async (c) => {
  return c.json({ draft: await getDraft(agentContext(c), c.req.param("id")) });
});

v1Routes.patch("/drafts/:id", async (c) => {
  const draft = await updateDraft(agentContext(c), c.req.param("id"), await jsonBody(c.req));
  return c.json({ draft });
});

v1Routes.delete("/drafts/:id", async (c) => {
  await deleteDraft(agentContext(c), c.req.param("id"));
  return c.json({ ok: true });
});

v1Routes.post("/drafts/:id/send", async (c) => {
  const ctx = agentContext(c);
  const body = await jsonBody(c.req);
  return c.json(
    await sendDraft(ctx, c.req.param("id"), { version: body.version, quota: ctx.quota }),
    201,
  );
});

// --- Sending ---------------------------------------------------------------

v1Routes.post("/uploads", async (c) => {
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "Expected a multipart 'file' field" }, 400);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "Attachment exceeds the 20 MB limit" }, 413);
  }
  return c.json(
    await stageUpload(agentContext(c), {
      filename: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    }),
    201,
  );
});

v1Routes.post("/send", async (c) => {
  const ctx = agentContext(c);
  const input = sendInputFromBody(await jsonBody(c.req));
  return c.json(await sendMessage(ctx, { ...input, quota: ctx.quota }), 201);
});

// Reply / reply-all / forward and send in one call. Built as a draft (same
// prefill as draft-reply), sent, and the draft removed — or removed on failure.
async function sendComposed(
  c: Context<AgentEnv>,
  modeFor: (body: Body) => ReplyMode,
) {
  const ctx = agentContext(c);
  const body = await jsonBody(c.req);
  const mode = modeFor(body);
  const draft = await createReplyDraft(ctx, c.req.param("id") ?? "", mode, {
    text: str(body.text),
    html: str(body.html),
  });
  try {
    if (mode === "forward") {
      await updateDraft(ctx, draft.id, { to: body.to, cc: body.cc ?? [] });
    }
    return c.json(await sendDraft(ctx, draft.id, { quota: ctx.quota }), 201);
  } catch (err) {
    await deleteDraft(ctx, draft.id).catch(() => undefined);
    throw err;
  }
}

v1Routes.post("/messages/:id/reply", (c) =>
  sendComposed(c, (body) => (body.mode === "reply_all" ? "reply_all" : "reply")),
);

v1Routes.post("/messages/:id/forward", (c) => sendComposed(c, () => "forward"));

// --- Calendar --------------------------------------------------------------

v1Routes.get("/calendar/events", async (c) => {
  return c.json({
    events: await listEvents(agentContext(c), {
      from: c.req.query("from"),
      to: c.req.query("to"),
      mailboxId: c.req.query("mailboxId"),
    }),
  });
});

v1Routes.get("/events/:id", async (c) => {
  return c.json({ event: await getEvent(agentContext(c), c.req.param("id")) });
});

v1Routes.post("/events/:id/rsvp", async (c) => {
  const body = await jsonBody(c.req);
  return c.json({
    partstat: await rsvpEvent(agentContext(c), c.req.param("id"), body.partstat),
  });
});

// Nothing else lives under /api/v1; never fall through to session routes.
v1Routes.all("*", (c) => c.json({ error: "Not found" }, 404));
