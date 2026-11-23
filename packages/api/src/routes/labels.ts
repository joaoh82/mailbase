import { labels } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { hasMailboxAccess } from "../lib/access";
import type { AppEnv } from "../lib/context";
import { sessionServiceContext } from "../lib/service-context";
import {
  createLabel,
  listLabels,
  normalizeLabelColor,
} from "../services/message-actions";

// User-defined labels (MAIL-16), scoped to a shared mailbox. Any member of a
// mailbox may manage its labels (like the shared signature), so authorization
// reuses hasMailboxAccess everywhere — a non-member gets the same 404 as a
// missing mailbox/label, never an existence leak (multi-domain invariant).

export const labelRoutes = new Hono<AppEnv>();

const MAX_NAME_LENGTH = 64;
// Colors are '' (default chip) or #rrggbb, so the UI palette stays bounded.
const normalizeColor = normalizeLabelColor;

/** A label the user may manage: it exists and they belong to its mailbox. */
async function getManageableLabel(
  db: DrizzleD1Database,
  userId: string,
  labelId: string,
): Promise<typeof labels.$inferSelect | undefined> {
  const label = await db
    .select()
    .from(labels)
    .where(eq(labels.id, labelId))
    .get();
  if (!label) return undefined;
  if (!(await hasMailboxAccess(db, userId, label.mailboxId))) return undefined;
  return label;
}

// All labels for a mailbox the user belongs to (sidebar + apply menu).
labelRoutes.get("/", async (c) => {
  return c.json({
    labels: await listLabels(
      sessionServiceContext(c),
      c.req.query("mailboxId") ?? "",
    ),
  });
});

// Create a label in a mailbox the user belongs to.
labelRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const label = await createLabel(sessionServiceContext(c), {
    mailboxId: typeof body?.mailboxId === "string" ? body.mailboxId : "",
    name: body?.name,
    color: body?.color,
  });
  return c.json({ label }, 201);
});

// Rename and/or recolor a label.
labelRoutes.patch("/:labelId", async (c) => {
  const db = drizzle(c.env.DB);
  const label = await getManageableLabel(
    db,
    c.get("user").id,
    c.req.param("labelId"),
  );
  if (!label) return c.json({ error: "Label not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const update: { name?: string; color?: string } = {};
  if (body?.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) {
      return c.json(
        { error: `name must be 1–${MAX_NAME_LENGTH} characters` },
        400,
      );
    }
    update.name = name;
  }
  if (body?.color !== undefined) {
    const color = normalizeColor(body.color);
    if (color === null) {
      return c.json({ error: "color must be a #rrggbb hex value" }, 400);
    }
    update.color = color;
  }
  if (update.name === undefined && update.color === undefined) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  try {
    await db.update(labels).set(update).where(eq(labels.id, label.id));
  } catch {
    return c.json({ error: "A label with that name already exists" }, 409);
  }
  return c.json({
    label: {
      id: label.id,
      mailboxId: label.mailboxId,
      name: update.name ?? label.name,
      color: update.color ?? label.color,
    },
  });
});

// Delete a label. message_labels rows cascade-delete via the FK, so the label
// silently drops off every message that carried it.
labelRoutes.delete("/:labelId", async (c) => {
  const db = drizzle(c.env.DB);
  const label = await getManageableLabel(
    db,
    c.get("user").id,
    c.req.param("labelId"),
  );
  if (!label) return c.json({ error: "Label not found" }, 404);

  await db.delete(labels).where(eq(labels.id, label.id));
  return c.json({ ok: true });
});
