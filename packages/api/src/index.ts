import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { mcpRoutes } from "./agent/mcp";
import { v1Routes } from "./agent/rest";
import { csrfProtection, requireAdmin, requireAuth } from "./lib/auth";
import type { AppEnv } from "./lib/context";
import { adminRoutes } from "./routes/admin";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { calendarRoutes, eventRoutes } from "./routes/calendar";
import { draftRoutes } from "./routes/drafts";
import { inviteRoutes, publicInviteRoutes } from "./routes/invites";
import { labelRoutes } from "./routes/labels";
import { mailboxRoutes } from "./routes/mailboxes";
import { messageRoutes } from "./routes/messages";
import { sendRoutes } from "./routes/send";
import { threadRoutes } from "./routes/threads";
import { tokenRoutes } from "./routes/tokens";
import { webhookRoutes } from "./routes/webhooks";
import { ServiceError } from "./services/context";

const app = new Hono<AppEnv>();

// Services throw ServiceError for expected failures (not found, forbidden,
// validation, limits); turn it into the API's usual `{ error }` JSON. Anything
// else is a bug: log it (no bodies or tokens) and return a bare 500.
function onError(err: Error, c: Context) {
  if (err instanceof ServiceError) {
    return c.json(
      err.code ? { error: err.message, code: err.code } : { error: err.message },
      err.status,
    );
  }
  if (err instanceof HTTPException) return err.getResponse();
  console.error("Unhandled API error:", err);
  return c.json({ error: "Internal error" }, 500);
}
app.onError(onError);

app.get("/health", (c) => c.json({ status: "ok" }));

const api = new Hono<AppEnv>();
api.onError(onError);

// Public: login (no session yet), signed attachment downloads (the HMAC
// signature is the authorization), and provider webhooks (authenticated by
// their Svix signature). Everything registered after the session middleware
// below requires a session, plus a CSRF token on mutations.
api.route("/auth", authRoutes);
api.route("/attachments", attachmentRoutes);
api.route("/webhooks", webhookRoutes);
// Opening and accepting an invite is public — the one-time token is the
// authorization. Creating one (below) requires a session.
api.route("/invites", publicInviteRoutes);

// Agent access (Phase 8): bearer-token-only REST (/api/v1) and MCP (/api/mcp).
// Mounted BEFORE the session line on purpose: requireApiToken reads only
// `Authorization: Bearer mb_…` and ignores cookies, so these routes can't be
// driven cross-site (no CSRF exposure), and each sub-app ends in its own
// catch-all 404 so an unknown /v1 path never falls through to session routes.
// requireAuth (below) stays cookie-only, so a token never reaches a session
// route, /admin/*, token management or mailbox management.
api.route("/v1", v1Routes);
api.route("/mcp", mcpRoutes);

api.use("*", requireAuth, csrfProtection);
api.route("/mailboxes", mailboxRoutes);
api.route("/messages", messageRoutes);
api.route("/labels", labelRoutes);
api.route("/threads", threadRoutes);
api.route("/calendar", calendarRoutes);
api.route("/events", eventRoutes);
api.route("/send", sendRoutes);
api.route("/drafts", draftRoutes);
api.route("/invites", inviteRoutes);
// Personal API tokens are managed with a session only: a token can never mint,
// list or revoke tokens.
api.route("/tokens", tokenRoutes);
// Domain administration (Phase 5): a further requireAdmin gate, so only global
// admins can add or manage domains.
api.use("/admin/*", requireAdmin);
api.route("/admin", adminRoutes);

app.route("/api", api);

export default app;
