import { labels } from "@mailbase/shared";
import { asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { hasMailboxAccess } from "../lib/access";
import type { AppEnv } from "../lib/context";
import { serializeLabel } from "../lib/labels";

// User-defined labels (MAIL-16), scoped to a shared mailbox. Any member of a
// mailbox may manage its labels (like the shared signature), so authorization
// reuses hasMailboxAccess everywhere — a non-member gets the same 404 as a
// missing mailbox/label, never an existence leak (multi-domain invariant).

export const labelRoutes = new Hono<AppEnv>();

const MAX_NAME_LENGTH = 64;
// '' (default chip) or a #rrggbb hex value, so the UI palette stays bounded.
const COLOR_RE = /^#[0-9a-f]{6}$/;

/** Normalizes a color input to '' or #rrggbb, or null if it is invalid. */
function normalizeColor(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return COLOR_RE.test(lower) ? lower : null;
}

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
  const db = drizzle(c.env.DB);
  const mailboxId = c.req.query("mailboxId") ?? "";
  if (!(await hasMailboxAccess(db, c.get("user").id, mailboxId))) {
    return c.json({ error: "Mailbox not found" }, 404);
  }

  const rows = await db
    .select()
    .from(labels)
    .where(eq(labels.mailboxId, mailboxId))
    .orderBy(asc(labels.name))
    .all();
  return c.json({ labels: rows.map(serializeLabel) });
});

// Create a label in a mailbox the user belongs to.
labelRoutes.post("/", async (c) => {
  const db = drizzle(c.env.DB);
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  const mailboxId = typeof body?.mailboxId === "string" ? body.mailboxId : "";
  if (!(await hasMailboxAccess(db, c.get("user").id, mailboxId))) {
    return c.json({ error: "Mailbox not found" }, 404);
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    return c.json(
      { error: `name is required (1–${MAX_NAME_LENGTH} characters)` },
      400,
    );
  }
  const color = normalizeColor(body?.color);
  if (color === null) {
    return c.json({ error: "color must be a #rrggbb hex value" }, 400);
  }

  const id = crypto.randomUUID();
  try {
    await db.insert(labels).values({ id, mailboxId, name, color });
  } catch {
    // Unique (mailbox_id, name): a label by that name already exists here.
    return c.json({ error: "A label with that name already exists" }, 409);
  }
  return c.json({ label: { id, mailboxId, name, color } }, 201);
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
