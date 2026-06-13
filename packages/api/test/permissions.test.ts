import { SELF } from "cloudflare:test";
import {
  addresses,
  mailboxes,
  mailboxMembers,
  users,
} from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, login, seed, type LoginResult } from "./seed";

// Phase 4: shared inboxes, role enforcement, send-as scoping, and the invite
// flow. The base seed gives josh (owner of mbx-josh) and other (owner of
// mbx-other), each isolated. Each test layers on the extra rows it needs.

function get(path: string, who: LoginResult) {
  return SELF.fetch(`http://webmail.local${path}`, {
    headers: { Cookie: who.cookie },
  });
}

function send(
  method: "POST" | "DELETE",
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

// A shared support@ mailbox plus an empty bob mailbox (no members yet), used by
// the invite/shared-inbox scenarios. josh is made a global admin so it can set
// accounts up — the "admin creates invite" role.
async function setupSharedAndAdmin() {
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, "user-josh"));
  await db.insert(mailboxes).values([
    { id: "mbx-support", domainId: "dom-test", name: "support" },
    { id: "mbx-bob", domainId: "dom-test", name: "bob" },
  ]);
  await db.insert(addresses).values([
    { id: "addr-support", domainId: "dom-test", localPart: "support", mailboxId: "mbx-support" },
    { id: "addr-bob", domainId: "dom-test", localPart: "bob", mailboxId: "mbx-bob" },
    // An alias that sorts before "bob": the invite label must still read bob@,
    // not the first-sorting alias (regression guard for the label fix).
    { id: "addr-bob-alias", domainId: "dom-test", localPart: "aaa", mailboxId: "mbx-bob" },
  ]);
  // josh owns support@; bob will be added as a member later.
  await db
    .insert(mailboxMembers)
    .values({ mailboxId: "mbx-support", userId: "user-josh", role: "owner" });
}

beforeEach(seed);

describe("read scoping", () => {
  it("blocks reading a mailbox the user does not belong to", async () => {
    const other = await login("other@login.test");
    expect((await get("/api/mailboxes/mbx-josh/messages", other)).status).toBe(404);
    expect((await get("/api/mailboxes/mbx-josh/members", other)).status).toBe(404);
    expect((await get("/api/messages/msg-1", other)).status).toBe(404);
    expect((await get("/api/threads/thr-1", other)).status).toBe(404);
  });

  it("lists only the user's own mailboxes, with roles", async () => {
    const other = await login("other@login.test");
    const body = (await (await get("/api/mailboxes", other)).json()) as {
      mailboxes: { id: string; role: string }[];
    };
    // msg-foreign is a seeded unread inbox message in mbx-other.
    expect(body.mailboxes).toEqual([
      { id: "mbx-other", name: "other", domain: "testdomain.com", address: "other@testdomain.com", role: "owner", unread: 1, signature: "" },
    ]);
  });
});

describe("send-as scoping", () => {
  it("blocks sending as an identity in another user's mailbox", async () => {
    const other = await login("other@login.test");
    const res = await send(
      "POST",
      "/api/send",
      { identityId: "idn-josh", to: ["x@gmail.com"], subject: "spoof", text: "no" },
      other,
    );
    expect(res.status).toBe(403);
  });
});

describe("role enforcement", () => {
  it("lets only owners/admins create invites and add members", async () => {
    await setupSharedAndAdmin();
    const other = await login("other@login.test");

    // other is not a member of mbx-support at all → 403, no existence leak.
    expect(
      (await send("POST", "/api/invites", { email: "z@login.test", mailboxId: "mbx-support", role: "member" }, other)).status,
    ).toBe(403);
    expect(
      (await send("POST", "/api/mailboxes/mbx-support/members", { email: "other@login.test", role: "member" }, other)).status,
    ).toBe(403);

    // josh (admin) can.
    const josh = await login();
    expect(
      (await send("POST", "/api/invites", { email: "newbie@login.test", mailboxId: "mbx-support", role: "member" }, josh)).status,
    ).toBe(201);
  });
});

describe("invite flow", () => {
  it("onboards a new user, who then sees only their mailboxes and cannot send as josh", async () => {
    await setupSharedAndAdmin();
    const josh = await login();

    // Admin invites bob into his own mailbox (as owner).
    const inviteRes = await send(
      "POST",
      "/api/invites",
      { email: "bob@login.test", mailboxId: "mbx-bob", role: "owner" },
      josh,
    );
    expect(inviteRes.status).toBe(201);
    const { token } = (await inviteRes.json()) as { token: string };

    // Preview is public and shows where bob is headed.
    const preview = (await (
      await SELF.fetch(`http://webmail.local/api/invites/${token}`)
    ).json()) as { email: string; mailbox: string };
    expect(preview.email).toBe("bob@login.test");
    expect(preview.mailbox).toBe("bob@testdomain.com");

    // Accept: sets a password, creates the account, signs bob in.
    const acceptRes = await SELF.fetch(
      `http://webmail.local/api/invites/${token}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "bob-strong-pass", displayName: "Bob" }),
      },
    );
    expect(acceptRes.status).toBe(201);
    const acceptCookie = (acceptRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const { user: bobUser, csrfToken: bobCsrf } = (await acceptRes.json()) as {
      user: { id: string; email: string };
      csrfToken: string;
    };
    expect(bobUser.email).toBe("bob@login.test");
    const bob: LoginResult = { res: acceptRes, cookie: acceptCookie, csrfToken: bobCsrf };

    // The link is single-use.
    expect(
      (
        await SELF.fetch(`http://webmail.local/api/invites/${token}/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "again-strong", displayName: "x" }),
        })
      ).status,
    ).toBe(404);

    // Admin adds bob to the shared support@ inbox.
    expect(
      (await send("POST", "/api/mailboxes/mbx-support/members", { email: "bob@login.test", role: "member" }, josh)).status,
    ).toBe(201);

    // Bob now sees bob@ + support@ — and crucially NOT josh's mailbox.
    const boxes = (await (await get("/api/mailboxes", bob)).json()) as {
      mailboxes: { id: string }[];
    };
    expect(boxes.mailboxes.map((m) => m.id).sort()).toEqual(["mbx-bob", "mbx-support"]);

    // Bob cannot read josh's mail.
    expect((await get("/api/mailboxes/mbx-josh/messages", bob)).status).toBe(404);

    // Bob cannot send as josh…
    expect(
      (await send("POST", "/api/send", { identityId: "idn-josh", to: ["a@b.com"], subject: "x", text: "x" }, bob)).status,
    ).toBe(403);

    // …but CAN send as the shared support@ address (membership minted the identity).
    const { identities } = (await (await get("/api/send/identities", bob)).json()) as {
      identities: { id: string; address: string }[];
    };
    const supportIdentity = identities.find((i) => i.address === "support@testdomain.com");
    expect(supportIdentity).toBeDefined();
    const sentAsSupport = await send(
      "POST",
      "/api/send",
      { identityId: supportIdentity!.id, to: ["customer@gmail.com"], subject: "Re: ticket", text: "On it." },
      bob,
    );
    expect(sentAsSupport.status).toBe(201);
  });

  it("refuses to invite an email that already has an account", async () => {
    await setupSharedAndAdmin();
    const josh = await login();
    const res = await send(
      "POST",
      "/api/invites",
      { email: "other@login.test", mailboxId: "mbx-support", role: "member" },
      josh,
    );
    expect(res.status).toBe(409);
  });

  it("rejects an unknown or malformed invite token", async () => {
    expect((await SELF.fetch("http://webmail.local/api/invites/nope")).status).toBe(404);
  });
});

describe("member removal", () => {
  it("revokes a member and their send-as identity, but keeps the last owner", async () => {
    await setupSharedAndAdmin();
    const josh = await login();

    // Add other@ to support@, then remove them.
    expect(
      (await send("POST", "/api/mailboxes/mbx-support/members", { email: "other@login.test", role: "member" }, josh)).status,
    ).toBe(201);

    const other = await login("other@login.test");
    // other can now see support@ and send as it.
    let identities = (await (await get("/api/send/identities", other)).json()) as {
      identities: { address: string }[];
    };
    expect(identities.identities.some((i) => i.address === "support@testdomain.com")).toBe(true);

    expect(
      (await send("DELETE", "/api/mailboxes/mbx-support/members/user-other", undefined, josh)).status,
    ).toBe(200);

    // Membership and the support identity are both gone.
    expect((await get("/api/mailboxes/mbx-support/members", other)).status).toBe(404);
    identities = (await (await get("/api/send/identities", other)).json()) as {
      identities: { address: string }[];
    };
    expect(identities.identities.some((i) => i.address === "support@testdomain.com")).toBe(false);

    // josh is the last owner of support@ and cannot be removed.
    expect(
      (await send("DELETE", "/api/mailboxes/mbx-support/members/user-josh", undefined, josh)).status,
    ).toBe(400);
  });
});
