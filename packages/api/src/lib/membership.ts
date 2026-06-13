import {
  addresses,
  identities,
  type MailboxRole,
  mailboxMembers,
  users,
} from "@mailbase/shared";
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { User } from "./context";

// Role checks for mailbox management (Phase 4). Reads are gated separately by
// hasMailboxAccess in lib/access.ts; these gate *managing* a mailbox —
// inviting users and adding/removing members.

/** The user's role in a mailbox, or undefined if they are not a member. */
export async function getMailboxRole(
  db: DrizzleD1Database,
  userId: string,
  mailboxId: string,
): Promise<MailboxRole | undefined> {
  const row = await db
    .select({ role: mailboxMembers.role })
    .from(mailboxMembers)
    .where(
      and(
        eq(mailboxMembers.mailboxId, mailboxId),
        eq(mailboxMembers.userId, userId),
      ),
    )
    .get();
  return row?.role as MailboxRole | undefined;
}

/**
 * True if the user may manage a mailbox: a global admin, or an "owner" member
 * of that specific mailbox.
 */
export async function canManageMailbox(
  db: DrizzleD1Database,
  user: User,
  mailboxId: string,
): Promise<boolean> {
  if (user.isAdmin) return true;
  return (await getMailboxRole(db, user.id, mailboxId)) === "owner";
}

/**
 * Add a user to a mailbox with the given role and give them a send-as identity
 * for every address of that mailbox (so shared-inbox members can send as the
 * shared address, and aliases each become a usable from-address). Idempotent:
 * re-granting an existing membership/identity is a no-op. A mailbox with no
 * addresses yet simply mints no identities — membership is still granted.
 */
export async function grantMailboxMembership(
  db: DrizzleD1Database,
  userId: string,
  mailboxId: string,
  role: MailboxRole,
  displayName: string,
): Promise<void> {
  await db
    .insert(mailboxMembers)
    .values({ mailboxId, userId, role })
    .onConflictDoNothing();

  const mailboxAddresses = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(eq(addresses.mailboxId, mailboxId))
    .all();

  for (const address of mailboxAddresses) {
    await db
      .insert(identities)
      .values({
        id: crypto.randomUUID(),
        userId,
        addressId: address.id,
        displayName,
      })
      .onConflictDoNothing();
  }
}

/**
 * Mint a send-as identity on a *newly added* address for every current member
 * of its mailbox, so a fresh alias is immediately usable as a from-address by
 * everyone who shares the mailbox. The counterpart to grantMailboxMembership,
 * which mints identities the other way round (a new member × all addresses).
 * Idempotent via the (user_id, address_id) unique index.
 */
export async function mintIdentitiesForAddress(
  db: DrizzleD1Database,
  addressId: string,
  mailboxId: string,
): Promise<void> {
  const members = await db
    .select({ userId: mailboxMembers.userId, displayName: users.displayName })
    .from(mailboxMembers)
    .innerJoin(users, eq(users.id, mailboxMembers.userId))
    .where(eq(mailboxMembers.mailboxId, mailboxId))
    .all();

  for (const member of members) {
    await db
      .insert(identities)
      .values({
        id: crypto.randomUUID(),
        userId: member.userId,
        addressId,
        displayName: member.displayName,
      })
      .onConflictDoNothing();
  }
}
