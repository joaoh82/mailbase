import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CloudflareApi,
  CloudflareApiError,
  isCloudflareRoutingMx,
  RealCloudflareApi,
} from "../src/lib/provisioning/cloudflare";
import { findApexMxConflicts } from "../src/lib/provisioning";

// Regression for the apex Email-Routing enable call. Cloudflare's
// POST /email/routing/dns treats a `name` field as a *subdomain* to scope
// routing to, and validates it must be strictly below the zone apex. Sending
// the apex itself fails with "2007 Invalid Input: must be a subdomain of
// <zone>". The apex case (what mailbase wants) must send NO body.

function cfSuccess(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], result }), {
    headers: { "Content-Type": "application/json" },
  });
}

function cfError(status: number, errors: { code: number; message: string }[]) {
  return new Response(JSON.stringify({ success: false, errors, result: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RealCloudflareApi.enableEmailRouting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to the zone's email/routing/dns with no body (apex routing)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(cfSuccess({ enabled: true, status: "ready" }));

    const api = new RealCloudflareApi("token-abc", "account-xyz");
    const status = await api.enableEmailRouting("zone-123");

    expect(status).toEqual({ enabled: true, status: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone-123/email/routing/dns",
    );
    expect(init?.method).toBe("POST");
    // The crux: no `name` (or any) body. A populated body is what triggered the
    // 2007 "must be a subdomain" rejection on the zone apex.
    expect(init?.body).toBeUndefined();
  });

  it("throws a CloudflareApiError carrying the error codes (e.g. 2008)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      cfError(409, [{ code: 2008, message: "Non-Cloudflare MX records exist" }]),
    );
    const api = new RealCloudflareApi("token-abc", "account-xyz");

    const err = await api.enableEmailRouting("zone-123").catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareApiError);
    expect((err as CloudflareApiError).codes).toContain(2008);
    expect((err as CloudflareApiError).httpStatus).toBe(409);
  });
});

describe("RealCloudflareApi DNS record list/delete", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listDnsRecords filters by type+name and maps the fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      cfSuccess([
        { id: "rec-1", type: "MX", name: "ex.com", content: ".", priority: 0 },
      ]),
    );
    const api = new RealCloudflareApi("token-abc", "account-xyz");

    const records = await api.listDnsRecords("zone-123", {
      type: "MX",
      name: "ex.com",
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone-123/dns_records?type=MX&name=ex.com",
    );
    expect(records).toEqual([
      { id: "rec-1", type: "MX", name: "ex.com", content: ".", priority: 0 },
    ]);
  });

  it("deleteDnsRecord issues a DELETE to the record's URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(cfSuccess({ id: "rec-1" }));
    const api = new RealCloudflareApi("token-abc", "account-xyz");

    await api.deleteDnsRecord("zone-123", "rec-1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone-123/dns_records/rec-1",
    );
    expect(init?.method).toBe("DELETE");
  });
});

describe("isCloudflareRoutingMx", () => {
  it("recognises Cloudflare's routing MX, rejects everything else", () => {
    expect(isCloudflareRoutingMx("route1.mx.cloudflare.net")).toBe(true);
    expect(isCloudflareRoutingMx("route3.mx.cloudflare.net.")).toBe(true);
    expect(isCloudflareRoutingMx(" route2.mx.cloudflare.net ")).toBe(true);
    // Conflicting / non-Cloudflare MX:
    expect(isCloudflareRoutingMx(".")).toBe(false); // null MX
    expect(isCloudflareRoutingMx("feedback-smtp.us-east-1.amazonses.com")).toBe(
      false,
    );
    expect(isCloudflareRoutingMx("aspmx.l.google.com")).toBe(false);
    // Guard against a sneaky lookalike hostname.
    expect(isCloudflareRoutingMx("mx.cloudflare.net.evil.com")).toBe(false);
  });
});

describe("findApexMxConflicts", () => {
  it("returns only non-Cloudflare MX, and only ever queries the apex", async () => {
    const calls: { type?: string; name?: string }[] = [];
    const fake = {
      listDnsRecords: async (
        _zoneId: string,
        query: { type?: string; name?: string } = {},
      ) => {
        calls.push(query);
        return [
          { id: "null-mx", type: "MX", name: "ex.com", content: ".", priority: 0 },
          {
            id: "cf-mx",
            type: "MX",
            name: "ex.com",
            content: "route1.mx.cloudflare.net",
            priority: 1,
          },
        ];
      },
    } as unknown as CloudflareApi;

    const conflicts = await findApexMxConflicts(fake, "zone-123", "ex.com");

    // Only the apex was queried — Resend's `send.ex.com` MX is never in scope.
    expect(calls).toEqual([{ type: "MX", name: "ex.com" }]);
    // Cloudflare's own routing MX is excluded; only the null MX is a conflict.
    expect(conflicts).toEqual([
      { id: "null-mx", name: "ex.com", content: ".", priority: 0 },
    ]);
  });
});
