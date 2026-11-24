import { attachments, labels, messageLabels, messages } from "@mailbase/shared";
import { and, asc, eq } from "drizzle-orm";
import { getAccessibleMessage, hasMailboxAccess } from "../lib/access";
import {
  ATTACHMENT_URL_TTL_SECONDS,
  attachmentSignature,
  requireSigningKey,
} from "../lib/attachment-urls";
import { serializeLabel } from "../lib/labels";
import { type ServiceContext, ServiceError } from "./context";

// Organizing mail: flags, moves, labels and attachment links. Shared by the
// webmail routes and the agent REST/MCP surface; every action first resolves
// the message through getAccessibleMessage (mailbox membership).

export const MOVE_TARGETS = ["inbox", "archive", "trash"] as const;
export type MoveTarget = (typeof MOVE_TARGETS)[number];

async function requireMessage(ctx: ServiceContext, messageId: string) {
  const message = await getAccessibleMessage(ctx.db, ctx.userId, messageId);
  if (!message) throw new ServiceError(404, "Message not found");
  return message;
}

export async function setMessageFlag(
  ctx: ServiceContext,
  messageId: string,
  flag: "isRead" | "isStarred",
  value: unknown,
): Promise<void> {
  const message = await requireMessage(ctx, messageId);
  if (typeof value !== "boolean") {
    throw new ServiceError(400, `${flag} must be a boolean`);
  }
  await ctx.db
    .update(messages)
    .set({ [flag]: value })
    .where(eq(messages.id, message.id));
}

/** Move to inbox/archive/trash (so archive, trash and restore). */
export async function moveMessage(
  ctx: ServiceContext,
  messageId: string,
  folder: unknown,
): Promise<void> {
  const message = await requireMessage(ctx, messageId);
  if (!MOVE_TARGETS.includes(folder as MoveTarget)) {
    throw new ServiceError(
      400,
      `folder must be one of: ${MOVE_TARGETS.join(", ")}`,
    );
  }
  await ctx.db
    .update(messages)
    .set({ folder: folder as MoveTarget })
    .where(eq(messages.id, message.id));
}

/**
 * Apply a label (idempotent). The label must belong to the message's mailbox,
 * so a message can never carry another mailbox's label (multi-domain
 * invariant); anything else is indistinguishable from "not found".
 */
export async function addMessageLabel(
  ctx: ServiceContext,
  messageId: string,
  labelId: string,
): Promise<void> {
  const message = await requireMessage(ctx, messageId);
  const label = await ctx.db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.id, labelId), eq(labels.mailboxId, message.mailboxId)))
    .get();
  if (!label) throw new ServiceError(404, "Label not found");
  await ctx.db
    .insert(messageLabels)
    .values({ messageId: message.id, labelId: label.id })
    .onConflictDoNothing();
}

/** Remove a label; removing an absent label is a no-op success. */
export async function removeMessageLabel(
  ctx: ServiceContext,
  messageId: string,
  labelId: string,
): Promise<void> {
  const message = await requireMessage(ctx, messageId);
  await ctx.db
    .delete(messageLabels)
    .where(
      and(
        eq(messageLabels.messageId, message.id),
        eq(messageLabels.labelId, labelId),
      ),
    );
}

/**
 * A signed, expiring download URL for one attachment of a message the user can
 * read. Relative by default (the SPA); pass `origin` for an absolute URL that
 * an agent can fetch without a session.
 */
export async function attachmentUrl(
  ctx: ServiceContext,
  messageId: string,
  attachmentId: string,
  origin?: string,
) {
  const signingKey = requireSigningKey(ctx.env);
  const message = await requireMessage(ctx, messageId);
  const attachment = await ctx.db
    .select()
    .from(attachments)
    .where(
      and(eq(attachments.id, attachmentId), eq(attachments.messageId, message.id)),
    )
    .get();
  if (!attachment) throw new ServiceError(404, "Attachment not found");

  const expiresAt = Math.floor(Date.now() / 1000) + ATTACHMENT_URL_TTL_SECONDS;
  const sig = attachmentSignature(signingKey, attachment.id, expiresAt);
  const path = `/api/attachments/${attachment.id}?expires=${expiresAt}&sig=${sig}`;
  return {
    url: origin ? `${origin}${path}` : path,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

const MAX_LABEL_NAME_LENGTH = 64;
const COLOR_RE = /^#[0-9a-f]{6}$/;

/** Normalizes a color input to '' or #rrggbb, or null if it is invalid. */
export function normalizeLabelColor(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return COLOR_RE.test(lower) ? lower : null;
}

/** All labels of a mailbox the user belongs to. */
export async function listLabels(ctx: ServiceContext, mailboxId: string) {
  if (!(await hasMailboxAccess(ctx.db, ctx.userId, mailboxId))) {
    throw new ServiceError(404, "Mailbox not found");
  }
  const rows = await ctx.db
    .select()
    .from(labels)
    .where(eq(labels.mailboxId, mailboxId))
    .orderBy(asc(labels.name))
    .all();
  return rows.map(serializeLabel);
}

/** Create a label in a mailbox the user belongs to. */
export async function createLabel(
  ctx: ServiceContext,
  input: { mailboxId: string; name: unknown; color?: unknown },
) {
  if (!(await hasMailboxAccess(ctx.db, ctx.userId, input.mailboxId))) {
    throw new ServiceError(404, "Mailbox not found");
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAX_LABEL_NAME_LENGTH) {
    throw new ServiceError(
      400,
      `name is required (1–${MAX_LABEL_NAME_LENGTH} characters)`,
    );
  }
  const color = normalizeLabelColor(input.color);
  if (color === null) {
    throw new ServiceError(400, "color must be a #rrggbb hex value");
  }
  const id = crypto.randomUUID();
  try {
    await ctx.db
      .insert(labels)
      .values({ id, mailboxId: input.mailboxId, name, color });
  } catch {
    // Unique (mailbox_id, name): a label by that name already exists here.
    throw new ServiceError(409, "A label with that name already exists");
  }
  return { id, mailboxId: input.mailboxId, name, color };
}
