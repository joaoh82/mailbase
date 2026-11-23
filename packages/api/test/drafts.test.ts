import { env, SELF } from "cloudflare:test";
import {
  draftAttachments,
  drafts,
  identities,
  mailboxMembers,
  messages,
  users,
} from "@mailbase/shared";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentFetch,
  createApiToken,
  db,
  login,
  seed,
  TEST_HASH,
  type LoginResult,
} from "./seed";

interface Draft {
  id: string;
  mailboxId: string;
  identityId: string | null;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  text: string;
  mode: string;
  sourceMessageId: string | null;
  version: number;
  attachments: { id: string; filename: string }[];
}

let token: string;
let auth: LoginResult;

beforeEach(async () => {
  await seed();
  ({ token } = await createApiToken());
  auth = await login();
});

const agent = (path: string, body?: unknown, method?: string) =>
  agentFetch(path, token, { body, method });

function session(path: string, body?: unknown, method?: string) {
  return SELF.fetch(`http://webmail.local${path}`, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers: {
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrfToken,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function draftOf(res: Response): Promise<Draft> {
  return ((await res.json()) as { draft: Draft }).draft;
}

describe("drafts CRUD", () => {
  it("an agent's draft shows up in the webmail and vice versa", async () => {
    const created = await agent("/api/v1/drafts", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "Hello",
      html: "<p>Hi<script>x()</script></p>",
    });
    expect(created.status).toBe(201);
    const draft = await draftOf(created);
    expect(draft).toMatchObject({
      mailboxId: "mbx-josh",
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      version: 1,
      mode: "new",
    });
    expect(draft.html).not.toContain("script");

    const listed = (await (await session("/api/drafts?mailboxId=mbx-josh")).json()) as {
      drafts: Draft[];
    };
    expect(listed.drafts.map((d) => d.id)).toEqual([draft.id]);

    const edited = await session(`/api/drafts/${draft.id}`, { version: 1, subject: "Hello!" }, "PATCH");
    expect(edited.status).toBe(200);
    expect((await draftOf(edited)).version).toBe(2);

    const fetched = await draftOf(await agent(`/api/v1/drafts/${draft.id}`));
    expect(fetched.subject).toBe("Hello!");

    expect((await agent(`/api/v1/drafts/${draft.id}`, undefined, "DELETE")).status).toBe(200);
    expect((await agent(`/api/v1/drafts/${draft.id}`)).status).toBe(404);
  });

  it("detects a version conflict", async () => {
    const draft = await draftOf(await agent("/api/v1/drafts", { identityId: "idn-josh" }));
    expect((await agent(`/api/v1/drafts/${draft.id}`, { version: 1, subject: "a" }, "PATCH")).status).toBe(200);
    const stale = await session(`/api/drafts/${draft.id}`, { version: 1, subject: "b" }, "PATCH");
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("draft_conflict");
  });

  it("is author-private, even within a shared mailbox", async () => {
    // user-other joins josh's mailbox as a member.
    await db.insert(mailboxMembers).values({ mailboxId: "mbx-josh", userId: "user-other" });
    const draft = await draftOf(await agent("/api/v1/drafts", { identityId: "idn-josh" }));
    const other = await createApiToken("user-other");
    expect((await agentFetch(`/api/v1/drafts/${draft.id}`, other.token)).status).toBe(404);
    const theirs = (await (
      await agentFetch("/api/v1/drafts?mailboxId=mbx-josh", other.token)
    ).json()) as { drafts: unknown[] };
    expect(theirs.drafts).toEqual([]);
    expect(
      (await agentFetch(`/api/v1/drafts/${draft.id}/send`, other.token, { body: {} })).status,
    ).toBe(404);
  });

  it("refuses another user's identity or mailbox", async () => {
    expect((await agent("/api/v1/drafts", { identityId: "idn-other" })).status).toBe(403);
    expect((await agent("/api/v1/drafts", { mailboxId: "mbx-other" })).status).toBe(404);
    const draft = await draftOf(await agent("/api/v1/drafts", { mailboxId: "mbx-josh" }));
    expect(
      (await agent(`/api/v1/drafts/${draft.id}`, { identityId: "idn-other" }, "PATCH")).status,
    ).toBe(403);
  });

  it("carries uploaded attachments and cleans them up on delete", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" }));
    const up = await SELF.fetch("http://webmail.local/api/v1/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    expect(up.status).toBe(201);
    const { uploadId } = (await up.json()) as { uploadId: string };

    const draft = await draftOf(
      await agent("/api/v1/drafts", { identityId: "idn-josh", uploadIds: [uploadId] }),
    );
    expect(draft.attachments.map((a) => a.filename)).toEqual(["notes.txt"]);
    const row = await db
      .select()
      .from(draftAttachments)
      .where(eq(draftAttachments.draftId, draft.id))
      .get();
    expect(row?.r2Key.startsWith(`drafts/${draft.id}/`)).toBe(true);
    expect(await env.MAIL_BUCKET.head(row!.r2Key)).not.toBeNull();

    await agent(`/api/v1/drafts/${draft.id}`, undefined, "DELETE");
    expect(await env.MAIL_BUCKET.head(row!.r2Key)).toBeNull();
  });
});

describe("reply / reply-all / forward drafts", () => {
  it("builds a reply to the sender with the quote", async () => {
    const res = await agent("/api/v1/messages/msg-rich/draft-reply", { mode: "reply", text: "Looks good." });
    expect(res.status).toBe(201);
    const draft = await draftOf(res);
    expect(draft).toMatchObject({
      identityId: "idn-josh",
      to: ["sender@remote.example"],
      cc: [],
      subject: "Re: Quarterly report",
      mode: "reply",
      sourceMessageId: "msg-rich",
    });
    expect(draft.text.startsWith("Looks good.")).toBe(true);
    expect(draft.text).toContain("sender@remote.example wrote:\n> The zanzibar numbers look great.");
  });

  it("reply-all recovers Cc from the raw message, minus the user's own addresses", async () => {
    await env.MAIL_BUCKET.put(
      "testdomain.com/mbx-josh/msg-1.eml",
      [
        "From: Alice <alice@remote.example>",
        "To: josh@testdomain.com, bob@remote.example",
        "Cc: carol@remote.example, JOSH@testdomain.com",
        "Subject: Message 1",
        "Message-ID: <msg-1@remote.example>",
        "",
        "Hi all",
        "",
      ].join("\r\n"),
    );
    await db
      .update(messages)
      .set({ fromAddr: "alice@remote.example", toAddrs: ["josh@testdomain.com", "bob@remote.example"] })
      .where(eq(messages.id, "msg-1"));
    const draft = await draftOf(await agent("/api/v1/messages/msg-1/draft-reply", { mode: "reply_all" }));
    expect(draft.to).toEqual(["alice@remote.example"]);
    expect(draft.cc).toEqual(["bob@remote.example", "carol@remote.example"]);
  });

  it("forward copies the source's attachments", async () => {
    const draft = await draftOf(await agent("/api/v1/messages/msg-rich/draft-reply", { mode: "forward" }));
    expect(draft.subject).toBe("Fwd: Quarterly report");
    expect(draft.to).toEqual([]);
    expect(draft.attachments.map((a) => a.filename)).toEqual(["report.png"]);
    expect(draft.text).toContain("---------- Forwarded message ----------");
  });

  it("can't reply to a message outside the user's mailboxes", async () => {
    expect((await agent("/api/v1/messages/msg-foreign/draft-reply", { mode: "reply" })).status).toBe(404);
  });
});

describe("sending a draft", () => {
  it("sends with threading, stores Sent, and deletes the draft and its objects", async () => {
    const draft = await draftOf(await agent("/api/v1/messages/msg-rich/draft-reply", { mode: "forward" }));
    await agent(`/api/v1/drafts/${draft.id}`, { to: ["boss@example.org"] }, "PATCH");
    const keys = (
      await db.select().from(draftAttachments).where(eq(draftAttachments.draftId, draft.id)).all()
    ).map((a) => a.r2Key);
    expect(keys).toHaveLength(1);

    const sent = await agent(`/api/v1/drafts/${draft.id}/send`, {});
    expect(sent.status).toBe(201);
    const body = (await sent.json()) as {
      message: { id: string; folder: string; attachments: unknown[] };
      providerMessageId: string;
    };
    expect(body.message.folder).toBe("sent");
    expect(body.message.attachments).toHaveLength(1);
    expect(body.providerMessageId).toMatch(/^mock-/);

    expect(await db.select().from(drafts).where(eq(drafts.id, draft.id)).get()).toBeUndefined();
    expect(await env.MAIL_BUCKET.head(keys[0]!)).toBeNull();
  });

  it("a webmail-sent reply draft threads into the parent's thread", async () => {
    const draft = await draftOf(
      await session("/api/drafts/from-message/msg-thread-reply", { mode: "reply" }),
    );
    const sent = await session(`/api/drafts/${draft.id}/send`, { version: draft.version });
    expect(sent.status).toBe(201);
    const { message } = (await sent.json()) as { message: { id: string; threadId: string } };
    expect(message.threadId).toBe("thr-1");
    const row = await db.select().from(messages).where(eq(messages.id, message.id)).get();
    const raw = await (await env.MAIL_BUCKET.get(row!.r2Key))!.text();
    expect(raw).toContain("In-Reply-To: <msg-reply@remote.example>");
  });

  it("re-checks identity and membership at send time", async () => {
    const draft = await draftOf(
      await agent("/api/v1/drafts", { identityId: "idn-josh", to: ["a@b.com"], text: "t" }),
    );
    // The identity is revoked after drafting.
    await db.delete(identities).where(eq(identities.id, "idn-josh"));
    const noIdentity = await agent(`/api/v1/drafts/${draft.id}/send`, {});
    expect(noIdentity.status).toBe(400); // identity_id was nulled by the FK

    // Membership revoked: the draft is no longer reachable at all.
    await db.insert(users).values({ id: "user-third", emailLogin: "t@login.test", passwordHash: TEST_HASH });
    const second = await draftOf(await agent("/api/v1/drafts", { mailboxId: "mbx-josh" }));
    await db
      .delete(mailboxMembers)
      .where(and(eq(mailboxMembers.mailboxId, "mbx-josh"), eq(mailboxMembers.userId, "user-josh")));
    expect((await agent(`/api/v1/drafts/${second.id}/send`, {})).status).toBe(404);
  });

  it("refuses a stale version and validates recipients", async () => {
    const draft = await draftOf(
      await agent("/api/v1/drafts", { identityId: "idn-josh", to: ["not an address"], text: "t" }),
    );
    expect((await agent(`/api/v1/drafts/${draft.id}/send`, { version: 99 })).status).toBe(409);
    expect((await agent(`/api/v1/drafts/${draft.id}/send`, {})).status).toBe(400);
  });
});
