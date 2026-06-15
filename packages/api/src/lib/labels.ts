import { labels, messageLabels } from "@mailbase/shared";
import { asc, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

// The wire shape for a label, shared by the label routes and the message
// serializers (rows/detail carry their labels so the SPA can show chips).
export interface SerializedLabel {
  id: string;
  mailboxId: string;
  name: string;
  color: string;
}

export function serializeLabel(
  row: typeof labels.$inferSelect,
): SerializedLabel {
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    name: row.name,
    color: row.color,
  };
}

/**
 * Labels for a page of messages, grouped by message id and sorted by name.
 * One grouped query — callers pass at most a page of ids (≤100, the D1 bound-
 * variable cap), the same bound the message-list endpoints already enforce.
 * Messages with no labels are simply absent from the map.
 */
export async function labelsByMessage(
  db: DrizzleD1Database,
  messageIds: string[],
): Promise<Map<string, SerializedLabel[]>> {
  const byMessage = new Map<string, SerializedLabel[]>();
  if (messageIds.length === 0) return byMessage;

  const rows = await db
    .select({
      messageId: messageLabels.messageId,
      id: labels.id,
      mailboxId: labels.mailboxId,
      name: labels.name,
      color: labels.color,
    })
    .from(messageLabels)
    .innerJoin(labels, eq(labels.id, messageLabels.labelId))
    .where(inArray(messageLabels.messageId, messageIds))
    .orderBy(asc(labels.name))
    .all();

  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push({
      id: row.id,
      mailboxId: row.mailboxId,
      name: row.name,
      color: row.color,
    });
    byMessage.set(row.messageId, list);
  }
  return byMessage;
}
