import { addresses, domains, mailboxes, messages } from "@mailbase/shared";
import { and, countDistinct, eq, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { AppEnv } from "../lib/context";
import { grantMailboxMembership, mintIdentitiesForAddress } from "../lib/membership";
import {
  CloudflareConfigError,
  createDomain,
  getDomainStatus,
  ProvisioningError,
  provisionDomain,
  resolveApexMxConflict,
  verifyResendDomain,
} from "../lib/provisioning";

// Admin-only domain management (Phase 5, DESIGN.md §5). Mounted behind
// requireAdmin in index.ts, so every handler here already has an admin user.
// "Add a domain" automates the Cloudflare/Resend runbook; the rest manages a
// domain's mailboxes, addresses and catch-all policy from the UI.

const LOCAL_PART_RE = /^[a-z0-9._-]+$/;

export const adminRoutes = new Hono<AppEnv>();

// A half-configured Cloudflare (one of the token/account pair missing) surfaces
// as a clear 500 anywhere in this section, rather than a generic error.
adminRoutes.onError((err, c) => {
  if (err instanceof CloudflareConfigError) {
    return c.json({ error: err.message }, 500);
  }
  throw err;
});

/** Loads a domain row, or null. */
async function loadDomain(db: DrizzleD1Database, id: string) {
  return db.select().from(domains).where(eq(domains.id, id)).get();
}

function domainSummary(d: typeof domains.$inferSelect) {
  return {
    id: d.id,
    name: d.name,
    rejectUnknown: d.rejectUnknown,
    catchAllMailboxId: d.catchAllMailboxId,
    resendVerified: d.resendVerified,
    // Empty handles mean the domain was seeded by hand (not via this UI).
    managed: Boolean(d.cloudflareZoneId || d.resendDomainId),
    cloudflareZoneId: d.cloudflareZoneId,
    resendDomainId: d.resendDomainId,
  };
}

// All domains with mailbox/address counts, newest first.
adminRoutes.get("/domains", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({
      domain: domains,
      mailboxCount: countDistinct(mailboxes.id),
      addressCount: countDistinct(addresses.id),
    })
    .from(domains)
    .leftJoin(mailboxes, eq(mailboxes.domainId, domains.id))
    .leftJoin(addresses, eq(addresses.domainId, domains.id))
    .groupBy(domains.id)
    .orderBy(domains.createdAt)
    .all();

  return c.json({
    domains: rows.map((r) => ({
      ...domainSummary(r.domain),
      mailboxCount: r.mailboxCount,
      addressCount: r.addressCount,
    })),
  });
});

// Add a domain: find/create the Cloudflare zone, register it with Resend, and
// insert the domains row + default mailbox/address. Returns the nameservers the
// operator must set at their registrar and the DNS records to verify.
adminRoutes.post("/domains", async (c) => {
  const db = drizzle(c.env.DB);
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const mailbox = typeof body?.mailbox === "string" && body.mailbox ? body.mailbox : "hello";

  try {
    const result = await createDomain(db, c.env, {
      name,
      mailbox,
      user: c.get("user"),
    });
    return c.json(
      {
        domain: domainSummary(result.domain),
        nameServers: result.zone.nameServers,
        zoneStatus: result.zone.status,
        resendStatus: result.registered.status,
        records: result.registered.records,
        simulated: result.simulated,
      },
      201,
    );
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return c.json({ error: err.message }, err.status as 400);
    }
    if (err instanceof CloudflareConfigError) throw err; // → onError (500)
    console.error("Add domain failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to add domain" },
      502,
    );
  }
});

// Domain detail: its mailboxes (each with its addresses) and catch-all policy.
adminRoutes.get("/domains/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const domain = await loadDomain(db, c.req.param("id"));
  if (!domain) return c.json({ error: "Domain not found" }, 404);

  const mailboxRows = await db
    .select({ id: mailboxes.id, name: mailboxes.name })
    .from(mailboxes)
    .where(eq(mailboxes.domainId, domain.id))
    .orderBy(mailboxes.name)
    .all();
  const addressRows = await db
    .select({
      id: addresses.id,
      localPart: addresses.localPart,
      mailboxId: addresses.mailboxId,
    })
    .from(addresses)
    .where(eq(addresses.domainId, domain.id))
    .orderBy(addresses.localPart)
    .all();

  const addressesByMailbox = new Map<string, typeof addressRows>();
  for (const a of addressRows) {
    const list = addressesByMailbox.get(a.mailboxId) ?? [];
    list.push(a);
    addressesByMailbox.set(a.mailboxId, list);
  }

  return c.json({
    domain: domainSummary(domain),
    mailboxes: mailboxRows.map((m) => ({
      id: m.id,
      name: m.name,
      address: `${m.name}@${domain.name}`,
      addresses: (addressesByMailbox.get(m.id) ?? []).map((a) => ({
        id: a.id,
        localPart: a.localPart,
        address: `${a.localPart}@${domain.name}`,
      })),
    })),
  });
});

// Catch-all policy: deliver unknown recipients to a mailbox, or reject them.
adminRoutes.patch("/domains/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const domain = await loadDomain(db, c.req.param("id"));
  if (!domain) return c.json({ error: "Domain not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const rejectUnknown = body?.rejectUnknown === true;
  const catchAllRaw = body?.catchAllMailboxId;
  let catchAllMailboxId: string | null =
    typeof catchAllRaw === "string" && catchAllRaw ? catchAllRaw : null;

  // Reject and catch-all are mutually exclusive; rejecting wins.
  if (rejectUnknown) catchAllMailboxId = null;

  if (catchAllMailboxId) {
    const mailbox = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.id, catchAllMailboxId), eq(mailboxes.domainId, domain.id)))
      .get();
    if (!mailbox) {
      return c.json({ error: "Catch-all mailbox is not in this domain" }, 400);
    }
  }

  await db
    .update(domains)
    .set({ rejectUnknown, catchAllMailboxId })
    .where(eq(domains.id, domain.id));
  return c.json({ ok: true });
});

// Live verification status from Cloudflare + Resend. Read-only from the
// client's view, though it reconciles the cached domains.resend_verified flag.
adminRoutes.get("/domains/:id/status", async (c) => {
  const db = drizzle(c.env.DB);
  const domain = await loadDomain(db, c.req.param("id"));
  if (!domain) return c.json({ error: "Domain not found" }, 404);
  return c.json(await getDomainStatus(db, c.env, domain));
});

// (Re-)run cloud provisioning: enable Email Routing, point the catch-all at the
// email worker, and write Resend's DNS records into the zone. Idempotent.
adminRoutes.post("/domains/:id/provision", async (c) => {
  const db = drizzle(c.env.DB);
  const domain = await loadDomain(db, c.req.param("id"));
  if (!domain) return c.json({ error: "Domain not found" }, 404);
  try {
    return c.json(await provisionDomain(db, c.env, domain));
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return c.json({ error: err.message }, err.status as 400);
    }
    throw err;
  }
});

// Resolve the apex-MX conflict that blocks Email Routing (Cloudflare error
// 2008): delete the offending non-Cloudflare apex MX record(s), then re-run
// provisioning. Subdomain MX (e.g. Resend's `send`) is never touched.
adminRoutes.post("/domains/:id/resolve-mx-conflict", async (c) => {
  const db = drizzle(c.env.DB);
  const domain = await loadDomain(db, c.req.param("id"));
  if (!domain) return c.json({ error: "Domain not found" }, 404);
  try {
    return c.json(await resolveApexMxConflict(db, c.env, domain));
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return c.json({ error: err.message }, err.status as 400);
    }
    throw err;
  }
});

// Ask Resend to re-check the domain's DNS, then return fresh status.
adminRoutes.post("/domains/:id/verify", async (c) => {
  const db = drizzle(c.env.DB);
  const domain = await loadDomain(db, c.req.param("id"));
  if (!domain) return c.json({ error: "Domain not found" }, 404);
  try {
    await verifyResendDomain(c.env, domain.resendDomainId);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return c.json({ error: err.message }, err.status as 400);
    }
    return c.json(
      { error: err instanceof Error ? err.message : "Verify failed" },
      502,
    );
  }
  return c.json(await getDomainStatus(db, c.env, domain));
});

// Add a mailbox to a domain, plus a same-named address, and make the admin its
// owner (membership + a send-as identity).
adminRoutes.post("/domains/:id/mailboxes", async (c) => {
  const db = drizzle(c.env.DB);
  const domain = await loadDomain(db, c.req.param("id"));
  if (!domain) return c.json({ error: "Domain not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const name =
    typeof body?.name === "string" ? body.name.trim().toLowerCase() : "";
  if (!LOCAL_PART_RE.test(name)) {
    return c.json({ error: "Mailbox name may use letters, digits, . _ - only" }, 400);
  }

  const existingMailbox = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.name, name)))
    .get();
  if (existingMailbox) {
    return c.json({ error: `Mailbox ${name} already exists` }, 409);
  }
  const existingAddress = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, name)))
    .get();
  if (existingAddress) {
    return c.json({ error: `Address ${name}@${domain.name} already exists` }, 409);
  }

  const mailboxId = crypto.randomUUID();
  await db.insert(mailboxes).values({ id: mailboxId, domainId: domain.id, name });
  await db.insert(addresses).values({
    id: crypto.randomUUID(),
    domainId: domain.id,
    localPart: name,
    mailboxId,
  });
  const user = c.get("user");
  await grantMailboxMembership(db, user.id, mailboxId, "owner", user.displayName);

  return c.json({ id: mailboxId, name, address: `${name}@${domain.name}` }, 201);
});

// Delete a mailbox — only if it holds no messages and isn't the catch-all
// target, so deletion can never silently drop stored mail or orphan the policy.
adminRoutes.delete("/domains/:id/mailboxes/:mailboxId", async (c) => {
  const db = drizzle(c.env.DB);
  const domain = await loadDomain(db, c.req.param("id"));
  if (!domain) return c.json({ error: "Domain not found" }, 404);
  const mailboxId = c.req.param("mailboxId");

  const mailbox = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.domainId, domain.id)))
    .get();
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  if (domain.catchAllMailboxId === mailboxId) {
    return c.json(
      { error: "This mailbox is the catch-all target; change the policy first" },
      400,
    );
  }
  const messageCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.mailboxId, mailboxId))
    .get();
  if ((messageCount?.count ?? 0) > 0) {
    return c.json({ error: "Mailbox is not empty; it still holds messages" }, 400);
  }

  // Addresses, members and identities for this mailbox cascade via FK.
  await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
  return c.json({ ok: true });
});

// Add an address (alias) to a mailbox; every current member gets a send-as
// identity for it.
adminRoutes.post("/domains/:id/addresses", async (c) => {
  const db = drizzle(c.env.DB);
  const domain = await loadDomain(db, c.req.param("id"));
  if (!domain) return c.json({ error: "Domain not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const localPart =
    typeof body?.localPart === "string" ? body.localPart.trim().toLowerCase() : "";
  const mailboxId = typeof body?.mailboxId === "string" ? body.mailboxId : "";
  if (!LOCAL_PART_RE.test(localPart)) {
    return c.json({ error: "Address may use letters, digits, . _ - only" }, 400);
  }

  const mailbox = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.domainId, domain.id)))
    .get();
  if (!mailbox) return c.json({ error: "Mailbox is not in this domain" }, 400);

  const existing = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, localPart)))
    .get();
  if (existing) {
    return c.json({ error: `${localPart}@${domain.name} already exists` }, 409);
  }

  const addressId = crypto.randomUUID();
  await db.insert(addresses).values({
    id: addressId,
    domainId: domain.id,
    localPart,
    mailboxId,
  });
  await mintIdentitiesForAddress(db, addressId, mailboxId);

  return c.json(
    { id: addressId, localPart, address: `${localPart}@${domain.name}` },
    201,
  );
});

// Remove an address (its send-as identities cascade via FK).
adminRoutes.delete("/domains/:id/addresses/:addressId", async (c) => {
  const db = drizzle(c.env.DB);
  const domain = await loadDomain(db, c.req.param("id"));
  if (!domain) return c.json({ error: "Domain not found" }, 404);
  const addressId = c.req.param("addressId");

  const address = await db
    .select({ id: addresses.id, mailboxId: addresses.mailboxId })
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.domainId, domain.id)))
    .get();
  if (!address) return c.json({ error: "Address not found" }, 404);

  // A mailbox must keep at least one address, or nothing routes to it by name
  // and future members get no send-as identity.
  const siblings = await db
    .select({ count: sql<number>`count(*)` })
    .from(addresses)
    .where(eq(addresses.mailboxId, address.mailboxId))
    .get();
  if ((siblings?.count ?? 0) <= 1) {
    return c.json(
      { error: "A mailbox must keep at least one address" },
      400,
    );
  }

  await db.delete(addresses).where(eq(addresses.id, addressId));
  return c.json({ ok: true });
});
