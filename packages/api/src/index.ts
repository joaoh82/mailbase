import { Hono } from "hono";
import { csrfProtection, requireAdmin, requireAuth } from "./lib/auth";
import type { AppEnv } from "./lib/context";
import { adminRoutes } from "./routes/admin";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { inviteRoutes, publicInviteRoutes } from "./routes/invites";
import { mailboxRoutes } from "./routes/mailboxes";
import { messageRoutes } from "./routes/messages";
import { sendRoutes } from "./routes/send";
import { threadRoutes } from "./routes/threads";
import { webhookRoutes } from "./routes/webhooks";

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));

const api = new Hono<AppEnv>();

// Public: login (no session yet), signed attachment downloads (the HMAC
// signature is the authorization), and provider webhooks (authenticated by
// their Svix signature). Everything registered after the middleware below
// requires a session, plus a CSRF token on mutations.
api.route("/auth", authRoutes);
api.route("/attachments", attachmentRoutes);
api.route("/webhooks", webhookRoutes);
// Opening and accepting an invite is public — the one-time token is the
// authorization. Creating one (below) requires a session.
api.route("/invites", publicInviteRoutes);

api.use("*", requireAuth, csrfProtection);
api.route("/mailboxes", mailboxRoutes);
api.route("/messages", messageRoutes);
api.route("/threads", threadRoutes);
api.route("/send", sendRoutes);
api.route("/invites", inviteRoutes);
// Domain administration (Phase 5): a further requireAdmin gate, so only global
// admins can add or manage domains.
api.use("/admin/*", requireAdmin);
api.route("/admin", adminRoutes);

app.route("/api", api);

export default app;
