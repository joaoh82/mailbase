import { describe, expect, it } from "vitest";
import type { CloudflareApi, DnsRecord, DnsRecordInput } from "../src/lib/provisioning";
import {
  authorizesCloudflareRouting,
  findApexSpfConflict,
  fixApexSpf,
  mergeApexSpf,
  txtValue,
} from "../src/lib/provisioning";

const CF = "v=spf1 include:_spf.mx.cloudflare.net ~all";
// What a domain bought at Namecheap arrives with (seen on four live zones).
const NAMECHEAP = "v=spf1 include:spf.efwd.registrar-servers.com ~all";

describe("txtValue", () => {
  it("unquotes and joins Cloudflare's 255-byte chunks", () => {
    expect(txtValue('"v=spf1 include:a.com" " ~all"')).toBe("v=spf1 include:a.com ~all");
    expect(txtValue(`"${CF}"`)).toBe(CF);
    expect(txtValue(CF)).toBe(CF);
  });
});

describe("authorizesCloudflareRouting", () => {
  it("matches the include case-insensitively, with or without '+'", () => {
    expect(authorizesCloudflareRouting(CF)).toBe(true);
    expect(authorizesCloudflareRouting("v=spf1 +INCLUDE:_spf.mx.cloudflare.net -all")).toBe(true);
    expect(authorizesCloudflareRouting(NAMECHEAP)).toBe(false);
    // A lookalike domain is not Cloudflare's include.
    expect(authorizesCloudflareRouting("v=spf1 include:_spf.mx.cloudflare.net.evil.com ~all")).toBe(
      false,
    );
  });
});

describe("mergeApexSpf", () => {
  it("replaces a stale registrar-forwarding SPF with exactly Cloudflare's record", () => {
    expect(mergeApexSpf([NAMECHEAP])).toBe(CF);
  });

  it("creates Cloudflare's record when there is none", () => {
    expect(mergeApexSpf([])).toBe(CF);
  });

  it("keeps every other sender and the existing all qualifier (Cloudflare's merge example)", () => {
    expect(mergeApexSpf(["v=spf1 include:_spf.google.com -all"])).toBe(
      "v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com -all",
    );
    expect(mergeApexSpf(["v=spf1 ip4:203.0.113.7 a mx:mail.ex.com ?all"])).toBe(
      "v=spf1 include:_spf.mx.cloudflare.net ip4:203.0.113.7 a mx:mail.ex.com ?all",
    );
  });

  it("collapses duplicate SPF records into one, deduplicating terms", () => {
    expect(
      mergeApexSpf([
        "v=spf1 include:_spf.google.com ~all",
        "v=spf1 include:_spf.google.com include:sendgrid.net -all",
      ]),
    ).toBe("v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com include:sendgrid.net ~all");
  });

  it("never duplicates Cloudflare's include and moves it first", () => {
    expect(mergeApexSpf(["v=spf1 include:a.com +include:_spf.mx.cloudflare.net ~all"])).toBe(
      "v=spf1 include:_spf.mx.cloudflare.net include:a.com ~all",
    );
  });

  it("keeps modifiers last and adds no all term next to a redirect", () => {
    expect(mergeApexSpf(["v=spf1 redirect=_spf.ex.com"])).toBe(
      "v=spf1 include:_spf.mx.cloudflare.net redirect=_spf.ex.com",
    );
    expect(mergeApexSpf(["v=spf1 exp=explain.ex.com include:a.com"])).toBe(
      "v=spf1 include:_spf.mx.cloudflare.net include:a.com ~all exp=explain.ex.com",
    );
  });
});

/** In-memory CloudflareApi over one zone's records, recording every write. */
function fakeZone(records: DnsRecord[]) {
  const listed: { type?: string; name?: string }[] = [];
  const writes: string[] = [];
  const api = {
    simulated: false,
    listDnsRecords: async (_zone: string, q: { type?: string; name?: string } = {}) => {
      listed.push(q);
      return records.filter((r) => (!q.type || r.type === q.type) && (!q.name || r.name === q.name));
    },
    updateDnsRecord: async (_zone: string, id: string, r: DnsRecordInput) => {
      writes.push(`update ${id} ${r.type} ${r.name} ${r.content}`);
    },
    createDnsRecord: async (_zone: string, r: DnsRecordInput) => {
      writes.push(`create ${r.type} ${r.name} ${r.content}`);
    },
    deleteDnsRecord: async (_zone: string, id: string) => {
      writes.push(`delete ${id}`);
    },
  } as unknown as CloudflareApi;
  return { api, listed, writes };
}

const txt = (id: string, name: string, value: string): DnsRecord => ({
  id,
  type: "TXT",
  name,
  content: `"${value}"`,
});

describe("findApexSpfConflict", () => {
  it("is null for one correct SPF, ignoring other apex TXT records", async () => {
    const { api, listed } = fakeZone([
      txt("verify", "ex.com", "google-site-verification=abc"),
      txt("spf", "ex.com", CF),
    ]);
    expect(await findApexSpfConflict(api, "z", "ex.com")).toBeNull();
    // Only the apex TXT records are ever in scope.
    expect(listed).toEqual([{ type: "TXT", name: "ex.com" }]);
  });

  it("reports a stale SPF with the proposed merged record", async () => {
    const { api } = fakeZone([
      txt("verify", "ex.com", "google-site-verification=abc"),
      txt("spf", "ex.com", NAMECHEAP),
    ]);
    expect(await findApexSpfConflict(api, "z", "ex.com")).toEqual({
      kind: "apex_spf",
      records: [{ id: "spf", content: NAMECHEAP }],
      proposed: CF,
    });
  });

  it("reports duplicates even when one of them is already correct", async () => {
    const { api } = fakeZone([txt("a", "ex.com", CF), txt("b", "ex.com", "v=spf1 include:x.com ~all")]);
    const conflict = await findApexSpfConflict(api, "z", "ex.com");
    expect(conflict?.records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(conflict?.proposed).toBe("v=spf1 include:_spf.mx.cloudflare.net include:x.com ~all");
  });
});

describe("fixApexSpf", () => {
  it("edits the stale SPF in place and touches nothing else", async () => {
    const { api, writes } = fakeZone([
      txt("verify", "ex.com", "google-site-verification=abc"),
      txt("spf", "ex.com", NAMECHEAP),
      txt("send-spf", "send.ex.com", "v=spf1 include:amazonses.com ~all"),
    ]);
    expect(await fixApexSpf(api, "z", "ex.com")).toEqual({ before: [NAMECHEAP], after: CF });
    expect(writes).toEqual([`update spf TXT ex.com "${CF}"`]);
  });

  it("merges duplicates into the first record and deletes the rest", async () => {
    const { api, writes } = fakeZone([
      txt("a", "ex.com", "v=spf1 include:x.com ~all"),
      txt("b", "ex.com", "v=spf1 include:y.com ~all"),
    ]);
    await fixApexSpf(api, "z", "ex.com");
    expect(writes).toEqual([
      'update a TXT ex.com "v=spf1 include:_spf.mx.cloudflare.net include:x.com include:y.com ~all"',
      "delete b",
    ]);
  });

  it("creates the record when the apex has no SPF", async () => {
    const { api, writes } = fakeZone([txt("verify", "ex.com", "google-site-verification=abc")]);
    await fixApexSpf(api, "z", "ex.com");
    expect(writes).toEqual([`create TXT ex.com "${CF}"`]);
  });

  it("is a no-op when the SPF is already correct", async () => {
    const { api, writes } = fakeZone([txt("spf", "ex.com", CF)]);
    expect(await fixApexSpf(api, "z", "ex.com")).toBeNull();
    expect(writes).toEqual([]);
  });
});
