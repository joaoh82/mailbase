import { Hono } from "hono";
import type { AppEnv } from "../lib/context";
import { sessionServiceContext } from "../lib/service-context";
import { getThread } from "../services/mail-query";

export const threadRoutes = new Hono<AppEnv>();

// Whole thread, oldest first, each message with its attachment list and
// indexed body text. HTML stays lazy via GET /api/messages/:id/full.
threadRoutes.get("/:id", async (c) => {
  return c.json(await getThread(sessionServiceContext(c), c.req.param("id")));
});
