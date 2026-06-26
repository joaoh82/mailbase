import { SELF } from "cloudflare:test";
import { addresses, domains, mailboxes, users } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, login, seed, type LoginResult } from "./seed";

// Phase 5: admin-only domain management and the "add a domain" automation. The
// test env sets neither CLOUDFLARE_API_TOKEN nor RESEND_API_KEY, so provisioning
// runs against the mock adapters (simulated: true) — the D1 side is exercised
// fully without any network call.

function get(path: string, who: LoginResult) {
  return SELF.fetch(`http://webmail.local${path}`, {
    headers: { Cookie: who.cookie },
  });
}

function send(
  method: "POST" | "DELETE" | "PATCH",
  path: string,
  body: unknown,
  who: LoginResult,
) {
  return SELF.fetch(`http://webmail.local${path}`, {
    method,
    headers: {
      Cookie: who.cookie,
      "X-CSRF-Token": who.csrfToken,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makeJoshAdmin() {
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, "user-josh"));
}

beforeEach(seed);

describe("admin gating", () => {
  it("blocks non-admins from the whole /admin section", async () => {
    const other = await login("other@login.test"); // owner of mbx-other, not admin
    expect((await get("/api/admin/domains", other)).status).toBe(403);
    expect(
      (await send("POST", "/api/admin/domains", { name: "x.com" }, other)).status,
    ).toBe(403);
  });

  it("lets an admin list domains", async () => {
    await makeJoshAdmin();
    const josh = await login();
    const res = await get("/api/admin/domains", josh);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domains: { name: string; managed: boolean; mailboxCount: number }[];
    };
    const seeded = body.domains.find((d) => d.name === "testdomain.com");
    expect(seeded).toBeDefined();
    expect(seeded!.managed).toBe(false); // seeded by hand, no provider handles
    expect(seeded!.mailboxCount).toBe(2); // mbx-josh + mbx-other
  });
});

describe("add a domain", () => {
  it("registers the domain, default mailbox/address, and makes the admin its owner", async () => {
    await makeJoshAdmin();
    const josh = await login();

    const res = await send(
      "POST",
      "/api/admin/domains",
      { name: "Example.NET", mailbox: "hello" },
      josh,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      domain: { id: string; name: string; managed: boolean };
      nameServers: string[];
      records: { type: string }[];
      simulated: boolean;
    };
    expect(body.simulated).toBe(true); // no real CF/Resend keys in tests
    expect(body.domain.name).toBe("example.net"); // normalized
    expect(body.domain.managed).toBe(true);
    expect(body.nameServers.length).toBeGreaterThan(0);
    expect(body.records.length).toBeGreaterThan(0);

    // D1: domain, mailbox, address all exist with the provider handles stored.
    const domain = await db
      .select()
      .from(domains)
      .where(eq(domains.name, "example.net"))
      .get();
    expect(domain).toBeDefined();
    expect(domain!.cloudflareZoneId).not.toBe("");
    expect(domain!.resendDomainId).not.toBe("");
    expect(domain!.catchAllMailboxId).not.toBeNull();

    const mailbox = await db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.domainId, domain!.id))
      .get();
    expect(mailbox!.name).toBe("hello");

    const address = await db
      .select()
      .from(addresses)
      .where(eq(addresses.domainId, domain!.id))
      .get();
    expect(address!.localPart).toBe("hello");

    // The admin can now see and send as the new mailbox.
    const boxes = (await (await get("/api/mailboxes", josh)).json()) as {
      mailboxes: { address: string }[];
    };
    expect(boxes.mailboxes.some((m) => m.address === "hello@example.net")).toBe(true);

    const ids = (await (await get("/api/send/identities", josh)).json()) as {
      identities: { address: string }[];
    };
    expect(ids.identities.some((i) => i.address === "hello@example.net")).toBe(true);
  });

  it("rejects an invalid domain name and a duplicate", async () => {
    await makeJoshAdmin();
    const josh = await login();
    expect(
      (await send("POST", "/api/admin/domains", { name: "not a domain" }, josh)).status,
    ).toBe(400);
    expect(
      (await send("POST", "/api/admin/domains", { name: "testdomain.com" }, josh)).status,
    ).toBe(409);
  });
});

describe("manage mailboxes, addresses and catch-all policy", () => {
  it("adds a mailbox + alias and mints send-as identities", async () => {
    await makeJoshAdmin();
    const josh = await login();
    const domainId = "dom-test";

    // New mailbox "support" → support@ address + owner membership.
    const mb = await send(
      "POST",
      `/api/admin/domains/${domainId}/mailboxes`,
      { name: "support", displayName: "Support Team" },
      josh,
    );
    expect(mb.status).toBe(201);
    const { id: supportMailboxId, displayName } = (await mb.json()) as {
      id: string;
      displayName: string;
    };
    expect(displayName).toBe("Support Team");

    // Alias help@ on the same mailbox.
    const alias = await send(
      "POST",
      `/api/admin/domains/${domainId}/addresses`,
      { localPart: "help", mailboxId: supportMailboxId },
      josh,
    );
    expect(alias.status).toBe(201);

    // josh has send-as identities for both support@ and help@.
    const ids = (await (await get("/api/send/identities", josh)).json()) as {
      identities: { address: string }[];
    };
    const addrs = ids.identities.map((i) => i.address);
    expect(addrs).toContain("support@testdomain.com");
    expect(addrs).toContain("help@testdomain.com");

    // Detail view groups addresses under their mailbox.
    const detail = (await (
      await get(`/api/admin/domains/${domainId}`, josh)
    ).json()) as {
      mailboxes: { id: string; addresses: { address: string }[] }[];
    };
    const support = detail.mailboxes.find((m) => m.id === supportMailboxId);
    expect(support!.addresses.map((a) => a.address).sort()).toEqual([
      "help@testdomain.com",
      "support@testdomain.com",
    ]);
  });

  it("removes an alias but refuses to remove a mailbox's last address", async () => {
    await makeJoshAdmin();
    const josh = await login();
    const domainId = "dom-test";

    const mb = await send(
      "POST",
      `/api/admin/domains/${domainId}/mailboxes`,
      { name: "support", displayName: "Support Team" },
      josh,
    );
    const { id: mailboxId } = (await mb.json()) as { id: string };
    const alias = await send(
      "POST",
      `/api/admin/domains/${domainId}/addresses`,
      { localPart: "help", mailboxId },
      josh,
    );
    const { id: aliasId } = (await alias.json()) as { id: string };

    // Removing the alias leaves support@ → allowed.
    expect(
      (await send("DELETE", `/api/admin/domains/${domainId}/addresses/${aliasId}`, undefined, josh)).status,
    ).toBe(200);

    // support@ is now the only address → cannot be removed.
    const remaining = await db
      .select()
      .from(addresses)
      .where(eq(addresses.mailboxId, mailboxId))
      .all();
    expect(remaining).toHaveLength(1);
    expect(
      (await send("DELETE", `/api/admin/domains/${domainId}/addresses/${remaining[0]!.id}`, undefined, josh)).status,
    ).toBe(400);
  });

  it("sets reject and catch-all policy", async () => {
    await makeJoshAdmin();
    const josh = await login();
    const domainId = "dom-test";

    // Reject unknown recipients.
    expect(
      (await send("PATCH", `/api/admin/domains/${domainId}`, { rejectUnknown: true }, josh)).status,
    ).toBe(200);
    let domain = await db.select().from(domains).where(eq(domains.id, domainId)).get();
    expect(domain!.rejectUnknown).toBe(true);
    expect(domain!.catchAllMailboxId).toBeNull();

    // Switch to catch-all into mbx-josh.
    expect(
      (
        await send(
          "PATCH",
          `/api/admin/domains/${domainId}`,
          { catchAllMailboxId: "mbx-josh" },
          josh,
        )
      ).status,
    ).toBe(200);
    domain = await db.select().from(domains).where(eq(domains.id, domainId)).get();
    expect(domain!.rejectUnknown).toBe(false);
    expect(domain!.catchAllMailboxId).toBe("mbx-josh");

    // A catch-all mailbox from another domain is rejected.
    await db.insert(domains).values({ id: "dom-other", name: "other.test" });
    await db.insert(mailboxes).values({ id: "mbx-elsewhere", domainId: "dom-other", name: "x" });
    expect(
      (
        await send(
          "PATCH",
          `/api/admin/domains/${domainId}`,
          { catchAllMailboxId: "mbx-elsewhere" },
          josh,
        )
      ).status,
    ).toBe(400);
  });

  it("refuses to delete a non-empty or catch-all mailbox, allows an empty one", async () => {
    await makeJoshAdmin();
    const josh = await login();
    const domainId = "dom-test";

    // mbx-josh has messages → 400.
    expect(
      (await send("DELETE", `/api/admin/domains/${domainId}/mailboxes/mbx-josh`, undefined, josh)).status,
    ).toBe(400);

    // A fresh empty mailbox can be deleted.
    const mb = await send(
      "POST",
      `/api/admin/domains/${domainId}/mailboxes`,
      { name: "temp", displayName: "Temp" },
      josh,
    );
    const { id: tempId } = (await mb.json()) as { id: string };
    expect(
      (await send("DELETE", `/api/admin/domains/${domainId}/mailboxes/${tempId}`, undefined, josh)).status,
    ).toBe(200);
    const gone = await db.select().from(mailboxes).where(eq(mailboxes.id, tempId)).get();
    expect(gone).toBeUndefined();
  });

  it("requires a From display name when creating a mailbox (MAIL-22)", async () => {
    await makeJoshAdmin();
    const josh = await login();
    const res = await send(
      "POST",
      "/api/admin/domains/dom-test/mailboxes",
      { name: "noname" },
      josh,
    );
    expect(res.status).toBe(400);
    // Whitespace-only is rejected too (sanitized to '').
    const blank = await send(
      "POST",
      "/api/admin/domains/dom-test/mailboxes",
      { name: "noname", displayName: "   " },
      josh,
    );
    expect(blank.status).toBe(400);
  });

  it("lets an owner edit a mailbox From name; a non-member cannot (MAIL-22)", async () => {
    const josh = await login(); // owner of mbx-josh (not a global admin)
    const ok = await send(
      "PATCH",
      "/api/mailboxes/mbx-josh/display-name",
      { displayName: "  Painel <News>  " },
      josh,
    );
    expect(ok.status).toBe(200);
    const { displayName } = (await ok.json()) as { displayName: string };
    // Sanitized: trimmed, angle brackets stripped, whitespace collapsed.
    expect(displayName).toBe("Painel News");
    const row = await db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.id, "mbx-josh"))
      .get();
    expect(row!.displayName).toBe("Painel News");

    // A user who neither owns nor admins this mailbox is refused.
    const other = await login("other@login.test");
    const denied = await send(
      "PATCH",
      "/api/mailboxes/mbx-josh/display-name",
      { displayName: "Hijack" },
      other,
    );
    expect(denied.status).toBe(403);
  });
});

describe("verification status and provisioning", () => {
  it("reports simulated status and runs provisioning for a managed domain", async () => {
    await makeJoshAdmin();
    const josh = await login();
    const added = await send(
      "POST",
      "/api/admin/domains",
      { name: "managed.test", mailbox: "team" },
      josh,
    );
    const { domain } = (await added.json()) as { domain: { id: string } };

    const status = (await (
      await get(`/api/admin/domains/${domain.id}/status`, josh)
    ).json()) as {
      zone: { status: string } | null;
      emailRouting: { enabled: boolean } | null;
      resend: { status: string } | null;
      simulated: boolean;
    };
    expect(status.simulated).toBe(true);
    expect(status.zone!.status).toBe("active");
    expect(status.emailRouting!.enabled).toBe(true);
    expect(status.resend!.status).toBe("not_started");

    const provision = (await (
      await send("POST", `/api/admin/domains/${domain.id}/provision`, undefined, josh)
    ).json()) as { steps: { ok: boolean }[]; simulated: boolean };
    expect(provision.steps.length).toBe(3);
    expect(provision.steps.every((s) => s.ok)).toBe(true);
  });

  it("returns empty status for a manually-seeded domain", async () => {
    await makeJoshAdmin();
    const josh = await login();
    const status = (await (
      await get("/api/admin/domains/dom-test/status", josh)
    ).json()) as { zone: null; resend: null };
    expect(status.zone).toBeNull();
    expect(status.resend).toBeNull();
  });
});

describe("all inboxes view", () => {
  it("aggregates a folder across the user's mailboxes, scoped to membership", async () => {
    const josh = await login();
    const res = await get("/api/mailboxes/all/messages?folder=inbox", josh);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: { id: string; mailboxId: string; mailboxAddress: string }[];
    };
    // Every item is from josh's mailbox and tagged with its address…
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.messages.every((m) => m.mailboxId === "mbx-josh")).toBe(true);
    expect(body.messages.every((m) => m.mailboxAddress === "josh@testdomain.com")).toBe(true);
    // …and msg-foreign (mbx-other) is never visible to josh.
    expect(body.messages.some((m) => m.id === "msg-foreign")).toBe(false);

    // The other user sees only their own inbox message.
    const other = await login("other@login.test");
    const otherBody = (await (
      await get("/api/mailboxes/all/messages?folder=inbox", other)
    ).json()) as { messages: { id: string; mailboxAddress: string }[] };
    expect(otherBody.messages.map((m) => m.id)).toEqual(["msg-foreign"]);
    expect(otherBody.messages[0]!.mailboxAddress).toBe("other@testdomain.com");
  });
});
