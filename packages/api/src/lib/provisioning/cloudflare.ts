// Cloudflare REST API adapter for domain provisioning (Phase 5, DESIGN.md §5).
//
// This is the ONLY place that talks to the Cloudflare API. The admin
// provisioning flow uses it to: find-or-create the zone, enable Email Routing,
// point the zone's catch-all rule at the inbound email worker, and write the
// DKIM/SPF DNS records Resend needs. Everything goes through the CloudflareApi
// interface so tests (and offline dev) run against MockCloudflareApi instead of
// the network — mirroring MailSender / MockMailSender.

const API_BASE = "https://api.cloudflare.com/client/v4";

/** A Cloudflare zone, as the admin UI needs it. */
export interface ZoneInfo {
  id: string;
  name: string;
  /** "pending" until the registrar's nameservers point at Cloudflare, then "active". */
  status: string;
  nameServers: string[];
}

export interface EmailRoutingStatus {
  enabled: boolean;
  /** "ready", "unconfigured", "misconfigured", … (Cloudflare's own enum). */
  status: string;
}

export interface CatchAllStatus {
  enabled: boolean;
  /** "worker", "forward", "drop", or "" when no rule exists. */
  action: string;
  /** Worker names / forward addresses the catch-all targets. */
  targets: string[];
}

export interface DnsRecordInput {
  type: string;
  /** Fully-qualified record name (e.g. "resend._domainkey.example.com"). */
  name: string;
  content: string;
  /** 1 = automatic. */
  ttl?: number;
  /** Required for MX records. */
  priority?: number;
}

/** A DNS record as returned by the Cloudflare API, trimmed to what we need. */
export interface DnsRecord {
  id: string;
  type: string;
  /** Fully-qualified record name (e.g. "example.com" or "send.example.com"). */
  name: string;
  content: string;
  priority?: number;
}

export interface CloudflareApi {
  /** True when this is the mock (no real Cloudflare calls happen). */
  readonly simulated: boolean;
  findOrCreateZone(name: string): Promise<ZoneInfo>;
  getZone(zoneId: string): Promise<ZoneInfo | null>;
  enableEmailRouting(zoneId: string): Promise<EmailRoutingStatus>;
  getEmailRoutingStatus(zoneId: string): Promise<EmailRoutingStatus>;
  setCatchAllToWorker(zoneId: string, workerName: string): Promise<void>;
  getCatchAll(zoneId: string): Promise<CatchAllStatus | null>;
  /** Create the record, or update it in place if one of the same type+name exists. */
  upsertDnsRecord(zoneId: string, record: DnsRecordInput): Promise<void>;
  /** List records in a zone, optionally filtered by type and/or exact name. */
  listDnsRecords(
    zoneId: string,
    query?: { type?: string; name?: string },
  ): Promise<DnsRecord[]>;
  deleteDnsRecord(zoneId: string, recordId: string): Promise<void>;
}

/**
 * A failed Cloudflare API call, carrying the structured error codes so callers
 * can branch on a specific failure (e.g. 2008 "Non-Cloudflare MX records
 * exist") instead of string-matching the message.
 */
export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly codes: number[],
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

/**
 * True when an MX record points at Cloudflare's Email Routing servers
 * (route1/2/3.mx.cloudflare.net). Anything else at the zone apex is what trips
 * error 2008 when enabling Email Routing.
 */
export function isCloudflareRoutingMx(content: string): boolean {
  return /(^|\.)mx\.cloudflare\.net\.?$/i.test(content.trim());
}

interface CfEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

export class RealCloudflareApi implements CloudflareApi {
  readonly simulated = false;

  constructor(
    private readonly apiToken: string,
    private readonly accountId: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!res.ok || !data || !data.success) {
      const detail =
        data?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ??
        `HTTP ${res.status}`;
      throw new CloudflareApiError(
        `Cloudflare ${method} ${path} failed: ${detail}`,
        data?.errors?.map((e) => e.code) ?? [],
        res.status,
      );
    }
    return data.result;
  }

  async findOrCreateZone(name: string): Promise<ZoneInfo> {
    const existing = await this.request<CfZone[]>(
      "GET",
      `/zones?name=${encodeURIComponent(name)}`,
    );
    if (existing.length > 0) return toZoneInfo(existing[0]!);

    const created = await this.request<CfZone>("POST", "/zones", {
      name,
      account: { id: this.accountId },
      type: "full",
    });
    return toZoneInfo(created);
  }

  async getZone(zoneId: string): Promise<ZoneInfo | null> {
    try {
      const zone = await this.request<CfZone>("GET", `/zones/${zoneId}`);
      return toZoneInfo(zone);
    } catch {
      return null;
    }
  }

  async enableEmailRouting(zoneId: string): Promise<EmailRoutingStatus> {
    // POST .../email/routing/dns both enables routing and adds+locks the
    // inbound MX/SPF records for the zone apex. Send no body: a `name` field
    // scopes routing to a subdomain, and Cloudflare validates it must be
    // strictly below the apex — passing the apex itself fails with
    // "2007 Invalid Input: must be a subdomain of <zone>". Omitting `name`
    // is the apex case we want.
    const settings = await this.request<CfRoutingSettings>(
      "POST",
      `/zones/${zoneId}/email/routing/dns`,
    );
    return { enabled: settings.enabled, status: settings.status };
  }

  async getEmailRoutingStatus(zoneId: string): Promise<EmailRoutingStatus> {
    const settings = await this.request<CfRoutingSettings>(
      "GET",
      `/zones/${zoneId}/email/routing`,
    );
    return { enabled: settings.enabled, status: settings.status };
  }

  async setCatchAllToWorker(
    zoneId: string,
    workerName: string,
  ): Promise<void> {
    await this.request("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
      name: "mailbase catch-all",
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [workerName] }],
    });
  }

  async getCatchAll(zoneId: string): Promise<CatchAllStatus | null> {
    try {
      const rule = await this.request<CfCatchAll>(
        "GET",
        `/zones/${zoneId}/email/routing/rules/catch_all`,
      );
      const action = rule.actions?.[0];
      return {
        enabled: rule.enabled,
        action: action?.type ?? "",
        targets: action?.value ?? [],
      };
    } catch {
      return null;
    }
  }

  async upsertDnsRecord(
    zoneId: string,
    record: DnsRecordInput,
  ): Promise<void> {
    const payload = {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl ?? 1,
      ...(record.priority !== undefined ? { priority: record.priority } : {}),
    };
    // Idempotent: one record per (type, name). Update in place if present so
    // re-running provisioning never duplicates records.
    const matches = await this.request<CfDnsRecord[]>(
      "GET",
      `/zones/${zoneId}/dns_records?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(record.name)}`,
    );
    if (matches.length > 0) {
      await this.request("PUT", `/zones/${zoneId}/dns_records/${matches[0]!.id}`, payload);
    } else {
      await this.request("POST", `/zones/${zoneId}/dns_records`, payload);
    }
  }

  async listDnsRecords(
    zoneId: string,
    query: { type?: string; name?: string } = {},
  ): Promise<DnsRecord[]> {
    const params = new URLSearchParams();
    if (query.type) params.set("type", query.type);
    if (query.name) params.set("name", query.name);
    const qs = params.toString();
    const records = await this.request<CfDnsRecord[]>(
      "GET",
      `/zones/${zoneId}/dns_records${qs ? `?${qs}` : ""}`,
    );
    return records.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      content: r.content,
      priority: r.priority,
    }));
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request("DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
  }
}

interface CfZone {
  id: string;
  name: string;
  status: string;
  name_servers?: string[];
}
interface CfRoutingSettings {
  enabled: boolean;
  status: string;
}
interface CfCatchAll {
  enabled: boolean;
  actions?: { type: string; value?: string[] }[];
}
interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

function toZoneInfo(zone: CfZone): ZoneInfo {
  return {
    id: zone.id,
    name: zone.name,
    status: zone.status,
    nameServers: zone.name_servers ?? [],
  };
}

// Simulates success without any network call. Used in tests and whenever
// CLOUDFLARE_API_TOKEN is unset (local dev): the add-domain flow runs end to
// end against D1, and the response is flagged `simulated` so the UI warns that
// nothing was really provisioned.
export class MockCloudflareApi implements CloudflareApi {
  readonly simulated = true;

  async findOrCreateZone(name: string): Promise<ZoneInfo> {
    return {
      id: `mock-zone-${name}`,
      name,
      status: "active",
      nameServers: ["ns1.mock-cloudflare.com", "ns2.mock-cloudflare.com"],
    };
  }
  async getZone(zoneId: string): Promise<ZoneInfo | null> {
    return {
      id: zoneId,
      name: "",
      status: "active",
      nameServers: ["ns1.mock-cloudflare.com", "ns2.mock-cloudflare.com"],
    };
  }
  async enableEmailRouting(_zoneId: string): Promise<EmailRoutingStatus> {
    return { enabled: true, status: "ready" };
  }
  async getEmailRoutingStatus(): Promise<EmailRoutingStatus> {
    return { enabled: true, status: "ready" };
  }
  async setCatchAllToWorker(): Promise<void> {}
  async getCatchAll(): Promise<CatchAllStatus | null> {
    return { enabled: true, action: "worker", targets: ["mailbase-email-worker"] };
  }
  async upsertDnsRecord(): Promise<void> {}
  async listDnsRecords(): Promise<DnsRecord[]> {
    return [];
  }
  async deleteDnsRecord(): Promise<void> {}
}

export function getCloudflareApi(env: Env): CloudflareApi {
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    return new RealCloudflareApi(
      env.CLOUDFLARE_API_TOKEN,
      env.CLOUDFLARE_ACCOUNT_ID,
    );
  }
  // Exactly one of the pair set is a misconfiguration: fail loudly rather than
  // silently simulating, which would report fake success on a real deploy.
  if (env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_ACCOUNT_ID) {
    const missing = env.CLOUDFLARE_API_TOKEN
      ? "CLOUDFLARE_ACCOUNT_ID"
      : "CLOUDFLARE_API_TOKEN";
    throw new CloudflareConfigError(
      `${missing} is not set; both CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to provision domains`,
    );
  }
  console.warn(
    "CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not set: using MockCloudflareApi; domains are recorded but not provisioned on Cloudflare.",
  );
  return new MockCloudflareApi();
}

/** Thrown by getCloudflareApi when the Cloudflare secrets are half-configured. */
export class CloudflareConfigError extends Error {}

/** Name of the inbound email worker the catch-all rule routes to. */
export function emailWorkerName(env: Env): string {
  return env.EMAIL_WORKER_NAME || "mailbase-email-worker";
}
