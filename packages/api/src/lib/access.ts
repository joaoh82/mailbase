import { mailboxMembers, messages, threads } from "@mailbase/shared";
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

// Every mailbox/message/thread read goes through these checks: nothing is
// reachable outside the user's mailbox memberships (multi-domain invariant).

export async function hasMailboxAccess(
  db: DrizzleD1Database,
  userId: string,
  mailboxId: string,
): Promise<boolean> {
  const row = await db
    .select({ mailboxId: mailboxMembers.mailboxId })
    .from(mailboxMembers)
    .where(
      and(
        eq(mailboxMembers.mailboxId, mailboxId),
        eq(mailboxMembers.userId, userId),
      ),
    )
    .get();
  return row !== undefined;
}

/** Message by id, only if the user is a member of its mailbox. */
export async function getAccessibleMessage(
  db: DrizzleD1Database,
  userId: string,
  messageId: string,
): Promise<typeof messages.$inferSelect | undefined> {
  const row = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.mailboxId, messages.mailboxId),
        eq(mailboxMembers.userId, userId),
      ),
    )
    .where(eq(messages.id, messageId))
    .get();
  return row?.message;
}

/** Thread by id, only if the user is a member of its mailbox. */
export async function getAccessibleThread(
  db: DrizzleD1Database,
  userId: string,
  threadId: string,
): Promise<typeof threads.$inferSelect | undefined> {
  const row = await db
    .select({ thread: threads })
    .from(threads)
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.mailboxId, threads.mailboxId),
        eq(mailboxMembers.userId, userId),
      ),
    )
    .where(eq(threads.id, threadId))
    .get();
  return row?.thread;
}
