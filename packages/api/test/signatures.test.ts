import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { login, seed, type LoginResult } from "./seed";

// Signatures (MAIL-4): per-identity signature with a per-mailbox default
// fallback, exposed on the read endpoints and editable via CSRF-checked PATCH
// routes scoped by identity ownership / mailbox membership.

let auth: LoginResult;

beforeEach(async () => {
  await seed();
  auth = await login();
});

function patch(path: string, body: unknown, who: LoginResult = auth) {
  return SELF.fetch(`http://webmail.local${path}`, {
    method: "PATCH",
    headers: {
      Cookie: who.cookie,
      "X-CSRF-Token": who.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, who: LoginResult = auth) {
  return SELF.fetch(`http://webmail.local${path}`, {
    headers: { Cookie: who.cookie },
  });
}

interface ApiIdentity {
  id: string;
  address: string;
  signature: string;
  mailboxSignature: string;
}

async function identities(who: LoginResult = auth): Promise<ApiIdentity[]> {
  const res = await get("/api/send/identities", who);
  expect(res.status).toBe(200);
  return ((await res.json()) as { identities: ApiIdentity[] }).identities;
}

describe("signature read shape", () => {
  it("exposes empty signature + mailbox default on identities by default", async () => {
    const josh = (await identities()).find((i) => i.id === "idn-josh");
    expect(josh).toMatchObject({
      id: "idn-josh",
      signature: "",
      mailboxSignature: "",
    });
  });

  it("exposes the mailbox's default signature on the mailbox list", async () => {
    const res = await get("/api/mailboxes");
    const body = (await res.json()) as { mailboxes: { id: string; signature: string }[] };
    const josh = body.mailboxes.find((m) => m.id === "mbx-josh");
    expect(josh?.signature).toBe("");
  });
});

describe("identity signatures", () => {
  it("lets a user set their own identity signature and sanitizes the HTML", async () => {
    const res = await patch("/api/send/identities/idn-josh", {
      signature:
        '<p>Cheers, <strong>Josh</strong></p><script>alert(1)</script>' +
        '<a href="https://josh.example" onclick="x()">site</a>',
    });
    expect(res.status).toBe(200);
    const { signature } = (await res.json()) as { signature: string };
    expect(signature).toContain("<strong>Josh</strong>");
    expect(signature).toContain('<a href="https://josh.example">site</a>');
    expect(signature).not.toContain("<script");
    expect(signature).not.toContain("onclick");

    // And it round-trips through the read endpoint.
    const josh = (await identities()).find((i) => i.id === "idn-josh");
    expect(josh?.signature).toBe(signature);
  });

  it("refuses to edit an identity the user does not own", async () => {
    const res = await patch("/api/send/identities/idn-other", {
      signature: "<p>nope</p>",
    });
    expect(res.status).toBe(404);
  });

  it("rejects a non-string signature", async () => {
    const res = await patch("/api/send/identities/idn-josh", { signature: 123 });
    expect(res.status).toBe(400);
  });

  it("requires a CSRF token", async () => {
    const res = await SELF.fetch(
      "http://webmail.local/api/send/identities/idn-josh",
      {
        method: "PATCH",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ signature: "<p>x</p>" }),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("mailbox default signatures", () => {
  it("lets a member set the mailbox default, exposed as the identity fallback", async () => {
    const res = await patch("/api/mailboxes/mbx-josh/signature", {
      signature: '<p>The Team</p><img src=x onerror="evil()">',
    });
    expect(res.status).toBe(200);
    const { signature } = (await res.json()) as { signature: string };
    expect(signature).toContain("<p>The Team</p>");
    expect(signature).not.toContain("onerror");
    expect(signature).not.toContain("<img");

    // Surfaces as the owning mailbox's default on the identity, so the composer
    // can fall back to it when the identity has no signature of its own.
    const josh = (await identities()).find((i) => i.id === "idn-josh");
    expect(josh?.signature).toBe("");
    expect(josh?.mailboxSignature).toBe(signature);
  });

  it("refuses to edit a mailbox the user is not a member of", async () => {
    const res = await patch("/api/mailboxes/mbx-other/signature", {
      signature: "<p>nope</p>",
    });
    expect(res.status).toBe(404);
  });

  it("requires a CSRF token", async () => {
    const res = await SELF.fetch(
      "http://webmail.local/api/mailboxes/mbx-josh/signature",
      {
        method: "PATCH",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ signature: "<p>x</p>" }),
      },
    );
    expect(res.status).toBe(403);
  });
});
