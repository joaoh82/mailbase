import { Hono } from "hono";
import { csrfProtection, requireAuth } from "./lib/auth";
import type { AppEnv } from "./lib/context";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { mailboxRoutes } from "./routes/mailboxes";
import { messageRoutes } from "./routes/messages";
import { threadRoutes } from "./routes/threads";

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));

const api = new Hono<AppEnv>();

// Public: login (no session yet) and signed attachment downloads (the HMAC
// signature is the authorization). Everything registered after the
// middleware below requires a session, plus a CSRF token on mutations.
api.route("/auth", authRoutes);
api.route("/attachments", attachmentRoutes);

api.use("*", requireAuth, csrfProtection);
api.route("/mailboxes", mailboxRoutes);
api.route("/messages", messageRoutes);
api.route("/threads", threadRoutes);

app.route("/api", api);

export default app;
