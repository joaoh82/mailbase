// Apex SPF reconciliation for Cloudflare Email Routing (Phase 5 provisioning).
//
// Enabling Email Routing adds an SPF record only when the apex has none. If the
// zone already carries one — typically a registrar's leftover email-forwarding
// record, e.g. Namecheap's `include:spf.efwd.registrar-servers.com` — Cloudflare
// leaves it alone and reports the zone "misconfigured" until the record gains
// `include:_spf.mx.cloudflare.net`. Cloudflare's guidance is to MERGE, not
// replace, since the existing record may still authorise a sender the domain
// uses (Google Workspace mid-migration, a newsletter tool, …). That is what
// mergeApexSpf does; fixApexSpf writes the result.

import type { CloudflareApi, DnsRecordInput } from "./cloudflare";

export const CLOUDFLARE_SPF_INCLUDE = "include:_spf.mx.cloudflare.net";

// Includes that only ever authorised a registrar's email *forwarding* MX. Once
// Email Routing is on, the apex MX is Cloudflare's alone (Cloudflare refuses to
// enable otherwise — error 2008), so these can no longer be in use and are
// dropped rather than carried into the merged record.
const DEAD_FORWARDING_INCLUDES = new Set(["include:spf.efwd.registrar-servers.com"]);

/**
 * The value of a TXT record as Cloudflare returns it: quoted, with long values
 * split into 255-byte chunks (`"v=spf1 …" "… ~all"`). Joins the chunks back up.
 */
export function txtValue(content: string): string {
  const chunks = content.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!chunks) return content.trim();
  return chunks.map((c) => c.slice(1, -1)).join("");
}

export function isSpf(value: string): boolean {
  return /^v=spf1(\s|$)/i.test(value.trim());
}

/** Normalised term for comparison: lower-case, explicit "+" qualifier dropped. */
function termKey(term: string): string {
  return term.toLowerCase().replace(/^\+/, "");
}

export function authorizesCloudflareRouting(spf: string): boolean {
  return spf.trim().split(/\s+/).some((t) => termKey(t) === CLOUDFLARE_SPF_INCLUDE);
}

/**
 * Merge zero or more apex SPF records into the single record Email Routing
 * needs: Cloudflare's include first, then every other mechanism from the
 * existing records (deduplicated, dead forwarding includes dropped), then the
 * first `all` term found (`~all` if there was none and no `redirect=`), then
 * any modifiers. More than one SPF record is itself an error (SPF permerror),
 * so duplicates collapse into one.
 */
export function mergeApexSpf(records: string[]): string {
  const mechanisms: string[] = [];
  const modifiers: string[] = [];
  const seen = new Set<string>();
  let all: string | undefined;

  for (const record of records) {
    for (const term of record.trim().split(/\s+/).slice(1)) {
      const key = termKey(term);
      if (key === CLOUDFLARE_SPF_INCLUDE || DEAD_FORWARDING_INCLUDES.has(key)) continue;
      if (/^[-~?]?all$/.test(key)) {
        all ??= term;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      // Modifiers (redirect=, exp=, …) are name=value; mechanisms use ":" or nothing.
      (/^[a-z][a-z0-9._-]*=/.test(key) ? modifiers : mechanisms).push(term);
    }
  }

  const hasRedirect = modifiers.some((m) => termKey(m).startsWith("redirect="));
  const tail = all ?? (hasRedirect ? undefined : "~all");
  return ["v=spf1", CLOUDFLARE_SPF_INCLUDE, ...mechanisms, ...(tail ? [tail] : []), ...modifiers].join(
    " ",
  );
}

/**
 * The apex SPF state is wrong for Email Routing: no SPF record, more than one,
 * or one that doesn't include Cloudflare's. `proposed` is the merged record
 * fixApexSpf would write, so the UI can show the exact change before applying it.
 */
export interface ApexSpfConflict {
  kind: "apex_spf";
  records: { id: string; content: string }[];
  proposed: string;
}

/** Null when the apex has exactly one SPF record and it authorises Cloudflare. */
export async function findApexSpfConflict(
  cloudflare: CloudflareApi,
  zoneId: string,
  apexName: string,
): Promise<ApexSpfConflict | null> {
  const records = (await cloudflare.listDnsRecords(zoneId, { type: "TXT", name: apexName }))
    .map((r) => ({ id: r.id, content: txtValue(r.content) }))
    .filter((r) => isSpf(r.content));
  if (records.length === 1 && authorizesCloudflareRouting(records[0]!.content)) {
    return null;
  }
  return {
    kind: "apex_spf",
    records,
    proposed: mergeApexSpf(records.map((r) => r.content)),
  };
}

/**
 * Rewrite the apex SPF to the merged record. Re-reads the zone (never trusts a
 * conflict the client echoes back), edits the first SPF record in place (or
 * creates one if there is none), and deletes any duplicate SPF records. Other
 * apex TXT records — site verifications and the like — are never touched.
 * Returns null, changing nothing, when the SPF is already correct.
 */
export async function fixApexSpf(
  cloudflare: CloudflareApi,
  zoneId: string,
  apexName: string,
): Promise<{ before: string[]; after: string } | null> {
  const conflict = await findApexSpfConflict(cloudflare, zoneId, apexName);
  if (!conflict) return null;

  const record: DnsRecordInput = {
    type: "TXT",
    name: apexName,
    // Cloudflare's documented TXT form is a quoted character-string.
    content: `"${conflict.proposed}"`,
    ttl: 1,
  };
  const [first, ...duplicates] = conflict.records;
  if (first) {
    await cloudflare.updateDnsRecord(zoneId, first.id, record);
  } else {
    await cloudflare.createDnsRecord(zoneId, record);
  }
  for (const duplicate of duplicates) {
    await cloudflare.deleteDnsRecord(zoneId, duplicate.id);
  }
  return { before: conflict.records.map((r) => r.content), after: conflict.proposed };
}
