// Resend Domains API adapter for domain provisioning (Phase 5, DESIGN.md §5).
//
// Registering a sending domain and reading its DKIM/SPF records is a different
// API surface from sending mail, but the same provider rule applies: all Resend
// HTTP lives behind an adapter, never inline at the call sites. Everything goes
// through DomainRegistrar so tests / offline dev use MockDomainRegistrar — like
// MailSender / MockMailSender.

const DOMAINS_ENDPOINT = "https://api.resend.com/domains";

/** One DNS record Resend needs in the zone to verify the domain. */
export interface DomainDnsRecord {
  /** "SPF", "DKIM", "DMARC", … (Resend's label for the record's purpose). */
  record: string;
  /** Record name relative to the domain (e.g. "send", "resend._domainkey"). */
  name: string;
  /** "MX", "TXT", "CNAME". */
  type: string;
  value: string;
  ttl: string;
  /** "not_started", "pending", "verified", "failed". */
  status: string;
  /** Present for MX records. */
  priority?: number;
}

export interface RegisteredDomain {
  id: string;
  name: string;
  /** "not_started", "pending", "verified", "failure", "temporary_failure". */
  status: string;
  records: DomainDnsRecord[];
}

export interface DomainRegistrar {
  /** True when this is the mock (no real Resend calls happen). */
  readonly simulated: boolean;
  addDomain(name: string): Promise<RegisteredDomain>;
  getDomain(id: string): Promise<RegisteredDomain | null>;
  verifyDomain(id: string): Promise<void>;
}

interface ResendDomainResponse {
  id: string;
  name: string;
  status: string;
  records?: DomainDnsRecord[];
}

export class ResendDomainRegistrar implements DomainRegistrar {
  readonly simulated = false;

  constructor(
    private readonly apiKey: string,
    private readonly region: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${DOMAINS_ENDPOINT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Resend ${method} /domains${path} failed (${res.status}): ${detail}`);
    }
    return (await res.json()) as T;
  }

  async addDomain(name: string): Promise<RegisteredDomain> {
    const data = await this.request<ResendDomainResponse>("POST", "", {
      name,
      region: this.region,
    });
    return normalize(data);
  }

  async getDomain(id: string): Promise<RegisteredDomain | null> {
    try {
      return normalize(await this.request<ResendDomainResponse>("GET", `/${id}`));
    } catch {
      return null;
    }
  }

  async verifyDomain(id: string): Promise<void> {
    await this.request("POST", `/${id}/verify`);
  }
}

function normalize(data: ResendDomainResponse): RegisteredDomain {
  return {
    id: data.id,
    name: data.name,
    status: data.status,
    records: data.records ?? [],
  };
}

// Simulates a freshly-added domain that still needs DNS verification. Used in
// tests and whenever RESEND_API_KEY is unset.
export class MockDomainRegistrar implements DomainRegistrar {
  readonly simulated = true;

  async addDomain(name: string): Promise<RegisteredDomain> {
    return {
      id: `mock-resend-${name}`,
      name,
      status: "not_started",
      records: [
        {
          record: "SPF",
          name: "send",
          type: "MX",
          value: "feedback-smtp.us-east-1.amazonses.com",
          ttl: "Auto",
          status: "not_started",
          priority: 10,
        },
        {
          record: "SPF",
          name: "send",
          type: "TXT",
          value: '"v=spf1 include:amazonses.com ~all"',
          ttl: "Auto",
          status: "not_started",
        },
        {
          record: "DKIM",
          name: "resend._domainkey",
          type: "CNAME",
          value: `${name}.dkim.amazonses.com`,
          ttl: "Auto",
          status: "not_started",
        },
      ],
    };
  }

  async getDomain(id: string): Promise<RegisteredDomain | null> {
    const name = id.replace(/^mock-resend-/, "");
    const domain = await this.addDomain(name);
    return { ...domain, id };
  }

  async verifyDomain(): Promise<void> {}
}

export function getDomainRegistrar(env: Env): DomainRegistrar {
  if (env.RESEND_API_KEY) {
    return new ResendDomainRegistrar(
      env.RESEND_API_KEY,
      env.RESEND_REGION || "us-east-1",
    );
  }
  console.warn(
    "RESEND_API_KEY not set: using MockDomainRegistrar; domains are recorded but not registered with Resend.",
  );
  return new MockDomainRegistrar();
}
