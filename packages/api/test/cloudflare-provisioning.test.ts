import { afterEach, describe, expect, it, vi } from "vitest";
import { RealCloudflareApi } from "../src/lib/provisioning/cloudflare";

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
});
