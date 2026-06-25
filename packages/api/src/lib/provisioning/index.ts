// Domain provisioning orchestration (Phase 5, DESIGN.md §5 runbook).
//
// Wraps the two provider adapters (Cloudflare, Resend) and the D1 writes behind
// three operations the admin routes call:
//   createDomain    — find/create the Cloudflare zone, register the Resend
//                     domain, and insert the domains row + default mailbox.
//   provisionDomain — enable Email Routing, point the catch-all at the email
//                     worker, and write Resend's DKIM/SPF records into the zone.
//                     Idempotent: safe to re-run once the zone is active.
//   getDomainStatus — read live verification status from both providers.
//
// createDomain is one synchronous call; provisionDomain/getDomainStatus are
// split out because they only succeed once the operator has delegated
// nameservers at the registrar (a manual GoDaddy step the UI explains).

import { addresses, domains, mailboxes } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { User } from "../context";
import { grantMailboxMembership } from "../membership";
import {
  type CloudflareApi,
  CloudflareApiError,
  emailWorkerName,
  getCloudflareApi,
  isCloudflareRoutingMx,
  type ZoneInfo,
} from "./cloudflare";
import {
  type DomainRegistrar,
  getDomainRegistrar,
  type RegisteredDomain,
} from "./resend-domains";

export * from "./cloudflare";
export * from "./resend-domains";

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/;
const LOCAL_PART_RE = /^[a-z0-9._-]+$/;

export class ProvisioningError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CreateDomainResult {
  domain: typeof domains.$inferSelect;
  zone: ZoneInfo;
  registered: RegisteredDomain;
  /** True if either provider ran as a mock (nothing was really provisioned). */
  simulated: boolean;
}

/**
 * Register a new domain: find-or-create its Cloudflare zone, add it to Resend,
 * then insert the domains row + a default mailbox/address and make the creating
 * admin its owner. Heavy cloud provisioning (Email Routing, DNS records) is a
 * separate step — see provisionDomain — because it needs the zone to be active.
 */
export async function createDomain(
  db: DrizzleD1Database,
  env: Env,
  opts: { name: string; mailbox: string; user: User },
): Promise<CreateDomainResult> {
  const name = opts.name.trim().toLowerCase();
  const mailboxName = opts.mailbox.trim().toLowerCase();
  if (!DOMAIN_RE.test(name)) {
    throw new ProvisioningError(400, "Enter a valid domain name, e.g. example.com");
  }
  if (!LOCAL_PART_RE.test(mailboxName)) {
    throw new ProvisioningError(
      400,
      "Mailbox name may use letters, digits, dots, dashes and underscores only",
    );
  }

  const existing = await db
    .select({ id: domains.id })
    .from(domains)
    .where(eq(domains.name, name))
    .get();
  if (existing) {
    throw new ProvisioningError(409, `${name} is already configured`);
  }

  const cloudflare = getCloudflareApi(env);
  const registrar = getDomainRegistrar(env);

  const zone = await cloudflare.findOrCreateZone(name);
  const registered = await registrar.addDomain(name);

  const domainId = crypto.randomUUID();
  const mailboxId = crypto.randomUUID();
  // domains.catch_all_mailbox_id references mailboxes(id), so the mailbox must
  // exist before we point the catch-all at it: insert the domain, then the
  // mailbox/address, then set the policy (same order as the seed).
  await db.insert(domains).values({
    id: domainId,
    name,
    cloudflareZoneId: zone.id,
    resendDomainId: registered.id,
  });
  await db.insert(mailboxes).values({
    id: mailboxId,
    domainId,
    name: mailboxName,
  });
  await db.insert(addresses).values({
    id: crypto.randomUUID(),
    domainId,
    localPart: mailboxName,
    mailboxId,
  });
  // Default to delivering unknown recipients to the default mailbox; the admin
  // can switch to reject, or repoint the catch-all, from the UI.
  await db
    .update(domains)
    .set({ catchAllMailboxId: mailboxId })
    .where(eq(domains.id, domainId));
  // Make the creating admin an owner so the new mailbox is usable immediately
  // (membership + a send-as identity for the address we just created).
  await grantMailboxMembership(
    db,
    opts.user.id,
    mailboxId,
    "owner",
    opts.user.displayName,
  );

  const domain = await db
    .select()
    .from(domains)
    .where(eq(domains.id, domainId))
    .get();

  return {
    domain: domain!,
    zone,
    registered,
    simulated: cloudflare.simulated || registrar.simulated,
  };
}

/**
 * A non-Cloudflare MX record at the zone apex blocks enabling Email Routing
 * (Cloudflare error 2008). We surface the offending records so the UI can offer
 * to remove them — see resolveApexMxConflict.
 */
export interface ApexMxConflict {
  kind: "apex_mx";
  records: { id: string; name: string; content: string; priority?: number }[];
}

export interface ProvisionStep {
  step: string;
  ok: boolean;
  detail: string;
  /** Present on a failed "Enable Email Routing" step caused by error 2008. */
  conflict?: ApexMxConflict;
}

/**
 * The non-Cloudflare MX records sitting at the zone apex. These are what
 * Cloudflare rejects with error 2008 when enabling Email Routing; subdomain MX
 * (e.g. Resend's `send` MX) and Cloudflare's own routing MX are excluded.
 */
export async function findApexMxConflicts(
  cloudflare: CloudflareApi,
  zoneId: string,
  apexName: string,
): Promise<ApexMxConflict["records"]> {
  const records = await cloudflare.listDnsRecords(zoneId, {
    type: "MX",
    name: apexName,
  });
  return records
    .filter((r) => !isCloudflareRoutingMx(r.content))
    .map((r) => ({
      id: r.id,
      name: r.name,
      content: r.content,
      priority: r.priority,
    }));
}

/**
 * Run the cloud-side provisioning for an already-registered domain: enable
 * Email Routing, point the catch-all rule at the email worker, and copy Resend's
 * DKIM/SPF records into the Cloudflare zone. Each step is reported independently
 * so a partial failure (e.g. the zone isn't active yet) is surfaced, not thrown.
 */
export async function provisionDomain(
  db: DrizzleD1Database,
  env: Env,
  domain: typeof domains.$inferSelect,
): Promise<{ steps: ProvisionStep[]; simulated: boolean }> {
  if (!domain.cloudflareZoneId || !domain.resendDomainId) {
    throw new ProvisioningError(
      400,
      "This domain was set up manually and has no provider handles to provision",
    );
  }

  const cloudflare = getCloudflareApi(env);
  const registrar = getDomainRegistrar(env);
  const steps: ProvisionStep[] = [];

  const run = async (
    step: string,
    fn: () => Promise<string>,
    onError?: (err: unknown) => Promise<ApexMxConflict | undefined>,
  ) => {
    try {
      steps.push({ step, ok: true, detail: await fn() });
    } catch (err) {
      let conflict: ApexMxConflict | undefined;
      if (onError) {
        // Best-effort enrichment: never let it mask the original failure.
        try {
          conflict = await onError(err);
        } catch {
          conflict = undefined;
        }
      }
      steps.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        conflict,
      });
    }
  };

  await run(
    "Enable Email Routing",
    async () => {
      const s = await cloudflare.enableEmailRouting(domain.cloudflareZoneId);
      return `status: ${s.status}`;
    },
    async (err) => {
      if (err instanceof CloudflareApiError && err.codes.includes(2008)) {
        const records = await findApexMxConflicts(
          cloudflare,
          domain.cloudflareZoneId,
          domain.name,
        );
        if (records.length > 0) return { kind: "apex_mx", records };
      }
      return undefined;
    },
  );
  await run("Route catch-all to the email worker", async () => {
    await cloudflare.setCatchAllToWorker(
      domain.cloudflareZoneId,
      emailWorkerName(env),
    );
    return `→ ${emailWorkerName(env)}`;
  });
  await run("Write Resend DKIM/SPF records", async () => {
    const resend = await registrar.getDomain(domain.resendDomainId);
    if (!resend) throw new Error("Resend domain not found");
    for (const record of resend.records) {
      await cloudflare.upsertDnsRecord(
        domain.cloudflareZoneId,
        toCloudflareRecord(record, domain.name),
      );
    }
    return `${resend.records.length} record(s)`;
  });

  return { steps, simulated: cloudflare.simulated || registrar.simulated };
}

export interface ResolveMxConflictResult {
  /** The apex MX records that were deleted to unblock Email Routing. */
  removed: { name: string; content: string }[];
  steps: ProvisionStep[];
  simulated: boolean;
}

/**
 * Delete the non-Cloudflare apex MX records that block Email Routing (error
 * 2008), then re-run provisioning. Only ever touches MX records at the zone
 * apex that don't point at Cloudflare's routing servers — never subdomain MX
 * (e.g. Resend's `send` MX) nor any other record type.
 */
export async function resolveApexMxConflict(
  db: DrizzleD1Database,
  env: Env,
  domain: typeof domains.$inferSelect,
): Promise<ResolveMxConflictResult> {
  if (!domain.cloudflareZoneId || !domain.resendDomainId) {
    throw new ProvisioningError(
      400,
      "This domain was set up manually and has no provider handles to provision",
    );
  }

  const cloudflare = getCloudflareApi(env);
  const conflicts = await findApexMxConflicts(
    cloudflare,
    domain.cloudflareZoneId,
    domain.name,
  );
  for (const record of conflicts) {
    await cloudflare.deleteDnsRecord(domain.cloudflareZoneId, record.id);
  }

  // Re-run the full (idempotent) provisioning so the caller gets fresh step
  // results — Enable Email Routing should now succeed.
  const { steps, simulated } = await provisionDomain(db, env, domain);
  return {
    removed: conflicts.map((r) => ({ name: r.name, content: r.content })),
    steps,
    simulated,
  };
}

export interface DomainStatus {
  zone: ZoneInfo | null;
  emailRouting: { enabled: boolean; status: string } | null;
  catchAll: { enabled: boolean; action: string; targets: string[] } | null;
  resend: {
    status: string;
    records: {
      record: string;
      name: string;
      type: string;
      value: string;
      status: string;
    }[];
  } | null;
  simulated: boolean;
}

/** Live verification status from Cloudflare + Resend for the verification view. */
export async function getDomainStatus(
  db: DrizzleD1Database,
  env: Env,
  domain: typeof domains.$inferSelect,
): Promise<DomainStatus> {
  const cloudflare = getCloudflareApi(env);
  const registrar = getDomainRegistrar(env);
  const simulated = cloudflare.simulated || registrar.simulated;

  if (!domain.cloudflareZoneId && !domain.resendDomainId) {
    // Manually-seeded domain: nothing to query.
    return { zone: null, emailRouting: null, catchAll: null, resend: null, simulated };
  }

  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };

  const zone = domain.cloudflareZoneId
    ? await safe(() => cloudflare.getZone(domain.cloudflareZoneId))
    : null;
  const emailRouting = domain.cloudflareZoneId
    ? await safe(() => cloudflare.getEmailRoutingStatus(domain.cloudflareZoneId))
    : null;
  const catchAll = domain.cloudflareZoneId
    ? await safe(() => cloudflare.getCatchAll(domain.cloudflareZoneId))
    : null;
  const resendDomain = domain.resendDomainId
    ? await safe(() => registrar.getDomain(domain.resendDomainId))
    : null;

  // Keep the persisted resend_verified flag in step with reality.
  if (resendDomain) {
    const verified = resendDomain.status === "verified";
    if (verified !== domain.resendVerified) {
      await db
        .update(domains)
        .set({ resendVerified: verified })
        .where(eq(domains.id, domain.id));
    }
  }

  return {
    zone,
    emailRouting,
    catchAll,
    resend: resendDomain
      ? {
          status: resendDomain.status,
          records: resendDomain.records.map((r) => ({
            record: r.record,
            name: r.name,
            type: r.type,
            value: r.value,
            status: r.status,
          })),
        }
      : null,
    simulated,
  };
}

/** Trigger a Resend re-verification check for a domain. */
export async function verifyResendDomain(env: Env, resendDomainId: string): Promise<void> {
  if (!resendDomainId) {
    throw new ProvisioningError(400, "This domain is not registered with Resend");
  }
  await getDomainRegistrar(env).verifyDomain(resendDomainId);
}

// Resend gives record names relative to the domain ("send", "resend._domainkey")
// and wraps TXT values in quotes; Cloudflare wants a fully-qualified name and an
// unquoted TXT value.
function toCloudflareRecord(
  record: { name: string; type: string; value: string; priority?: number },
  domainName: string,
) {
  const name =
    record.name === "@" || record.name === ""
      ? domainName
      : `${record.name}.${domainName}`;
  let content = record.value;
  if (record.type === "TXT" && content.startsWith('"') && content.endsWith('"')) {
    content = content.slice(1, -1);
  }
  return {
    type: record.type,
    name,
    content,
    ttl: 1,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
  };
}
