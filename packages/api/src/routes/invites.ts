import {
  addresses,
  domains,
  generateToken,
  hashPassword,
  invites,
  mailboxes,
  MAILBOX_ROLES,
  type MailboxRole,
  sessions,
  sha256Hex,
  users,
} from "@mailbase/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { AppEnv, User } from "../lib/context";
import { SESSION_TTL_SECONDS, setSessionCookie } from "../lib/auth";
import { canManageMailbox, grantMailboxMembership } from "../lib/membership";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MIN_PASSWORD_LENGTH = 8;

function publicUser(user: User) {
  return {
    id: user.id,
    email: user.emailLogin,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
  };
}

// The mailbox's primary address (its alphabetically-first local part), used to
// show the invitee which inbox they're joining. Falls back to name@domain.
async function mailboxAddressLabel(
  db: ReturnType<typeof drizzle>,
  mailboxId: string,
): Promise<string | null> {
  const row = await db
    .select({
      name: mailboxes.name,
      domain: domains.name,
      localPart: addresses.localPart,
    })
    .from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .leftJoin(addresses, eq(addresses.mailboxId, mailboxes.id))
    .where(eq(mailboxes.id, mailboxId))
    .orderBy(asc(addresses.localPart))
    .get();
  if (!row) return null;
  return `${row.localPart ?? row.name}@${row.domain}`;
}

// Public invite routes: opening the link and accepting it. No session — the
// one-time token is the authorization. Registered before requireAuth.
export const publicInviteRoutes = new Hono<AppEnv>();

publicInviteRoutes.get("/:token", async (c) => {
  const db = drizzle(c.env.DB);
  const invite = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, sha256Hex(c.req.param("token"))),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .get();
  if (!invite) {
    return c.json({ error: "This invitation is invalid or has expired" }, 404);
  }

  return c.json({
    email: invite.email,
    mailbox: await mailboxAddressLabel(db, invite.mailboxId),
  });
});

publicInviteRoutes.post("/:token/accept", async (c) => {
  const db = drizzle(c.env.DB);
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const password = typeof body?.password === "string" ? body.password : "";
  const displayName =
    typeof body?.displayName === "string" ? body.displayName.trim() : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      400,
    );
  }

  const tokenHash = sha256Hex(c.req.param("token"));
  const invite = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, tokenHash),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .get();
  if (!invite) {
    return c.json({ error: "This invitation is invalid or has expired" }, 404);
  }

  // Invites create *new* logins. If the email already exists, an owner adds
  // them to a mailbox via the members endpoint instead — accepting here would
  // need their existing password and risks account takeover.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailLogin, invite.email))
    .get();
  if (existing) {
    return c.json(
      { error: "An account with this email already exists; sign in instead" },
      409,
    );
  }

  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    emailLogin: invite.email,
    passwordHash: hashPassword(password),
    displayName,
  });
  await grantMailboxMembership(
    db,
    userId,
    invite.mailboxId,
    invite.role as MailboxRole,
    displayName,
  );
  // Single-use: stamp acceptance so the link cannot be replayed.
  await db
    .update(invites)
    .set({ acceptedAt: new Date() })
    .where(eq(invites.id, invite.id));

  // Auto sign-in: the invitee just proved control of the link and set a
  // password, so hand them a session like a fresh login.
  const token = generateToken();
  const csrfToken = generateToken();
  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash: sha256Hex(token),
    csrfToken,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  });
  setSessionCookie(c, token);

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  return c.json({ user: publicUser(user!), csrfToken }, 201);
});

// Authed invite routes: creating an invite. Registered after requireAuth +
// csrfProtection, so a session and CSRF token are already required.
export const inviteRoutes = new Hono<AppEnv>();

inviteRoutes.post("/", async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const mailboxId =
    typeof body?.mailboxId === "string" ? body.mailboxId : "";
  const roleInput = typeof body?.role === "string" ? body.role : "member";
  if (!EMAIL_RE.test(email)) {
    return c.json({ error: "A valid email is required" }, 400);
  }
  if (!(MAILBOX_ROLES as readonly string[]).includes(roleInput)) {
    return c.json({ error: `role must be one of: ${MAILBOX_ROLES.join(", ")}` }, 400);
  }
  const role = roleInput as MailboxRole;

  // Role enforcement: only an owner of this mailbox (or a global admin) may
  // invite into it. A non-member gets the same 403 — no mailbox existence leak.
  if (!(await canManageMailbox(db, user, mailboxId))) {
    return c.json({ error: "You cannot invite users to this mailbox" }, 403);
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailLogin, email))
    .get();
  if (existing) {
    return c.json(
      {
        error:
          "That email already has an account; add them as a member instead",
      },
      409,
    );
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_SECONDS * 1000);
  await db.insert(invites).values({
    id: crypto.randomUUID(),
    tokenHash: sha256Hex(token),
    email,
    mailboxId,
    role,
    invitedBy: user.id,
    expiresAt,
  });

  // Best-effort absolute link from the request origin; the SPA also rebuilds it
  // from its own origin, so a relative path is enough for the client.
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      token,
      url: `${origin}/?invite=${token}`,
      email,
      expiresAt: expiresAt.toISOString(),
    },
    201,
  );
});
