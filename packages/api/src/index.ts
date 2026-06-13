import { Hono } from "hono";
import { csrfProtection, requireAuth } from "./lib/auth";
import type { AppEnv } from "./lib/context";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
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

api.use("*", requireAuth, csrfProtection);
api.route("/mailboxes", mailboxRoutes);
api.route("/messages", messageRoutes);
api.route("/threads", threadRoutes);
api.route("/send", sendRoutes);

app.route("/api", api);

export default app;
