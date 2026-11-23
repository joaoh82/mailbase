import { env, SELF } from "cloudflare:test";
import {
  hmacSha256Base64,
  labels,
  mailboxMembers,
  messages,
  rateLimitCounters,
} from "@mailbase/shared";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ATTACHMENT_BYTES, agentFetch, createApiToken, db, seed } from "./seed";

let token: string;
let tokenId: string;

beforeEach(async () => {
  await seed();
  ({ token, id: tokenId } = await createApiToken());
});

const get = (path: string) => agentFetch(path, token);
const post = (path: string, body: unknown = {}) =>
  agentFetch(path, token, { body });

describe("reading", () => {
  it("lists only the caller's mailboxes and identities", async () => {
    const mbx = (await (await get("/api/v1/mailboxes")).json()) as {
      mailboxes: { id: string; unread: number }[];
    };
    expect(mbx.mailboxes.map((m) => m.id)).toEqual(["mbx-josh"]);
    const idn = (await (await get("/api/v1/identities")).json()) as {
      identities: { id: string; address: string }[];
    };
    expect(idn.identities).toEqual([
      expect.objectContaining({ id: "idn-josh", address: "josh@testdomain.com" }),
    ]);
  });

  it("lists, searches and paginates a mailbox", async () => {
    const page = (await (
      await get("/api/v1/mailboxes/mbx-josh/messages?limit=2")
    ).json()) as { messages: { id: string }[]; nextCursor: string };
    expect(page.messages.map((m) => m.id)).toEqual(["msg-rich", "msg-thread-reply"]);
    expect(page.nextCursor).toBeTruthy();

    const found = (await (
      await get("/api/v1/mailboxes/mbx-josh/search?q=zanzibar")
    ).json()) as { messages: { id: string }[] };
    expect(found.messages.map((m) => m.id).sort()).toEqual(["msg-2", "msg-rich"]);
  });

  it("returns 404 for another user's mailbox, message, thread and event", async () => {
    expect((await get("/api/v1/mailboxes/mbx-other/messages")).status).toBe(404);
    expect((await get("/api/v1/mailboxes/mbx-other/search?q=zanzibar")).status).toBe(404);
    expect((await get("/api/v1/messages/msg-foreign")).status).toBe(404);
    expect((await get("/api/v1/messages/new?mailboxId=mbx-other")).status).toBe(404);
    expect((await get("/api/v1/threads/thr-1")).status).toBe(200);
    const other = await createApiToken("user-other");
    expect((await agentFetch("/api/v1/threads/thr-1", other.token)).status).toBe(404);
    expect((await get("/api/v1/events/nope")).status).toBe(404);
  });

  it("reads a message as text by default, HTML only on request", async () => {
    const res = await get("/api/v1/messages/msg-rich");
    expect(res.status).toBe(200);
    const { message } = (await res.json()) as {
      message: Record<string, unknown> & {
        headers: { from: string; messageId: string };
        attachments: { id: string }[];
      };
    };
    expect(message.text).toContain("zanzibar");
    expect(message.truncated).toBe(false);
    expect(message).not.toHaveProperty("untrustedHtml");
    expect(message).not.toHaveProperty("bodyText");
    expect(message.headers.from).toBe("sender@remote.example");
    expect(message.attachments.map((a) => a.id)).toEqual(["att-1"]);

    const withHtml = (await (await get("/api/v1/messages/msg-rich?html=1")).json()) as {
      message: { untrustedHtml: string };
    };
    expect(withHtml.message.untrustedHtml).toContain("<b>zanzibar</b>");
  });

  it("truncates long bodies at 100 KB", async () => {
    await db
      .update(messages)
      .set({ bodyText: "x".repeat(150 * 1024) })
      .where(eq(messages.id, "msg-1"));
    const { message } = (await (await get("/api/v1/messages/msg-1")).json()) as {
      message: { text: string; truncated: boolean };
    };
    expect(message.truncated).toBe(true);
    expect(message.text.length).toBe(100 * 1024);
  });

  it("mints an absolute signed attachment URL that downloads", async () => {
    const res = await get("/api/v1/messages/msg-rich/attachments/att-1/url");
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^http:\/\/webmail\.local\/api\/attachments\/att-1\?expires=/);
    const download = await SELF.fetch(url);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(ATTACHMENT_BYTES);
  });
});

describe("check_new_mail polling", () => {
  async function insertMessage(id: string, mailboxId = "mbx-josh") {
    await db.insert(messages).values({
      id,
      mailboxId,
      r2Key: `testdomain.com/${mailboxId}/${id}.eml`,
      direction: "inbound",
      fromAddr: "new@remote.example",
      toAddrs: ["josh@testdomain.com"],
      subject: `New ${id}`,
      // A forged, ancient Date header must not hide the message.
      date: new Date(1000),
      createdAt: new Date(Math.floor(Date.now() / 1000 + 5) * 1000),
      messageIdHeader: `${id}@remote.example`,
    });
  }

  it("starts clean, then returns only mail that arrives after the cursor", async () => {
    const start = (await (await get("/api/v1/messages/new")).json()) as {
      messages: unknown[];
      nextCursor: string;
    };
    expect(start.messages).toEqual([]);

    const empty = (await (
      await get(`/api/v1/messages/new?since=${encodeURIComponent(start.nextCursor)}`)
    ).json()) as { messages: unknown[]; nextCursor: string };
    expect(empty.messages).toEqual([]);

    await insertMessage("msg-new-1");
    await insertMessage("msg-new-foreign", "mbx-other");
    const fresh = (await (
      await get(`/api/v1/messages/new?since=${encodeURIComponent(empty.nextCursor)}`)
    ).json()) as {
      messages: { id: string; mailboxAddress: string }[];
      nextCursor: string;
    };
    expect(fresh.messages.map((m) => m.id)).toEqual(["msg-new-1"]);
    expect(fresh.messages[0]?.mailboxAddress).toBe("josh@testdomain.com");

    const again = (await (
      await get(`/api/v1/messages/new?since=${encodeURIComponent(fresh.nextCursor)}`)
    ).json()) as { messages: unknown[] };
    expect(again.messages).toEqual([]);
  });

  it("rejects a malformed cursor", async () => {
    expect((await get("/api/v1/messages/new?since=garbage")).status).toBe(400);
  });
});

describe("organizing", () => {
  it("marks read, stars, moves and labels", async () => {
    expect((await post("/api/v1/messages/msg-1/read", { isRead: true })).status).toBe(200);
    expect((await post("/api/v1/messages/msg-1/star", { isStarred: true })).status).toBe(200);
    expect((await post("/api/v1/messages/msg-1/move", { folder: "archive" })).status).toBe(200);
    let row = await db.select().from(messages).where(eq(messages.id, "msg-1")).get();
    expect(row).toMatchObject({ isRead: true, isStarred: true, folder: "archive" });
    expect((await post("/api/v1/messages/msg-1/move", { folder: "trash" })).status).toBe(200);
    expect((await post("/api/v1/messages/msg-1/move", { folder: "inbox" })).status).toBe(200);
    expect((await post("/api/v1/messages/msg-1/move", { folder: "spam" })).status).toBe(400);
    row = await db.select().from(messages).where(eq(messages.id, "msg-1")).get();
    expect(row?.folder).toBe("inbox");

    const created = await post("/api/v1/mailboxes/mbx-josh/labels", { name: "Agent" });
    expect(created.status).toBe(201);
    const { label } = (await created.json()) as { label: { id: string } };
    expect(
      (await agentFetch(`/api/v1/messages/msg-1/labels/${label.id}`, token, { method: "PUT" }))
        .status,
    ).toBe(200);
    const listed = (await (
      await get(`/api/v1/mailboxes/mbx-josh/messages?labelId=${label.id}`)
    ).json()) as { messages: { id: string }[] };
    expect(listed.messages.map((m) => m.id)).toEqual(["msg-1"]);
    expect(
      (await agentFetch(`/api/v1/messages/msg-1/labels/${label.id}`, token, { method: "DELETE" }))
        .status,
    ).toBe(200);
    const labelsList = (await (await get("/api/v1/mailboxes/mbx-josh/labels")).json()) as {
      labels: { name: string }[];
    };
    expect(labelsList.labels.map((l) => l.name)).toEqual(["Agent"]);
  });

  it("can't organize another user's mail", async () => {
    expect((await post("/api/v1/messages/msg-foreign/read", { isRead: true })).status).toBe(404);
    expect((await post("/api/v1/messages/msg-foreign/move", { folder: "trash" })).status).toBe(404);
    expect((await post("/api/v1/mailboxes/mbx-other/labels", { name: "x" })).status).toBe(404);
    const foreignLabel = await db
      .insert(labels)
      .values({ id: "lbl-foreign", mailboxId: "mbx-other", name: "F" })
      .returning()
      .get();
    expect(
      (await agentFetch(`/api/v1/messages/msg-1/labels/${foreignLabel.id}`, token, { method: "PUT" }))
        .status,
    ).toBe(404);
  });
});

describe("sending", () => {
  it("sends a new message with a Sent copy like the webmail does", async () => {
    const res = await post("/api/v1/send", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "From the agent",
      html: "<p>Hi <script>alert(1)</script><b>there</b></p>",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      message: { id: string; folder: string };
      providerMessageId: string;
    };
    expect(body.message.folder).toBe("sent");
    expect(body.providerMessageId).toMatch(/^mock-/);
    const row = await db.select().from(messages).where(eq(messages.id, body.message.id)).get();
    expect(row?.providerMessageId).toBe(body.providerMessageId);
    expect(row?.bodyText).toContain("there");
    const raw = await (await env.MAIL_BUCKET.get(row!.r2Key))!.text();
    expect(raw).not.toContain("<script>");
  });

  it("refuses to send as another user's identity", async () => {
    const res = await post("/api/v1/send", { identityId: "idn-other", to: ["a@b.com"] });
    expect(res.status).toBe(403);
  });

  it("replies with threading headers and forwards with attachments", async () => {
    const reply = await post("/api/v1/messages/msg-rich/reply", { text: "Thanks!" });
    expect(reply.status).toBe(201);
    const sent = (await reply.json()) as { message: { id: string; threadId: string } };
    const row = await db.select().from(messages).where(eq(messages.id, sent.message.id)).get();
    expect(row?.toAddrs).toEqual(["sender@remote.example"]);
    expect(row?.subject).toBe("Re: Quarterly report");
    const raw = await (await env.MAIL_BUCKET.get(row!.r2Key))!.text();
    expect(raw).toContain("In-Reply-To: <q-report@remote.example>");
    expect(row?.bodyText).toContain("Thanks!");
    expect(row?.bodyText).toContain("> The zanzibar numbers look great.");

    const fwd = await post("/api/v1/messages/msg-rich/forward", {
      to: ["boss@example.org"],
      text: "FYI",
    });
    expect(fwd.status).toBe(201);
    const fwdBody = (await fwd.json()) as {
      message: { subject: string; attachments: { filename: string }[] };
    };
    expect(fwdBody.message.subject).toBe("Fwd: Quarterly report");
    expect(fwdBody.message.attachments.map((a) => a.filename)).toEqual(["report.png"]);

    // One-shot reply/forward leave no drafts behind.
    const drafts = (await (await get("/api/v1/drafts")).json()) as { drafts: unknown[] };
    expect(drafts.drafts).toEqual([]);
  });

  it("bounce webhooks update an agent-sent message", async () => {
    const res = await post("/api/v1/send", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "s",
      text: "t",
    });
    const { providerMessageId, message } = (await res.json()) as {
      providerMessageId: string;
      message: { id: string };
    };
    const payload = JSON.stringify({
      type: "email.bounced",
      data: { email_id: providerMessageId },
    });
    const svixId = "msg_1";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = hmacSha256Base64(
      new Uint8Array([0x74, 0x65, 0x73, 0x74, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74]),
      `${svixId}.${ts}.${payload}`,
    );
    const hook = await SELF.fetch("http://webmail.local/api/webhooks/resend", {
      method: "POST",
      headers: {
        "svix-id": svixId,
        "svix-timestamp": ts,
        "svix-signature": `v1,${sig}`,
        "Content-Type": "application/json",
      },
      body: payload,
    });
    expect(hook.status).toBe(200);
    const row = await db.select().from(messages).where(eq(messages.id, message.id)).get();
    expect(row?.deliveryStatus).toBe("bounced");
  });
});

describe("daily send cap", () => {
  it("refuses sends past the cap with 429", async () => {
    const capped = await createApiToken("user-josh", { dailySendCap: 2 });
    const send = () =>
      agentFetch("/api/v1/send", capped.token, {
        body: { identityId: "idn-josh", to: ["a@b.com"], subject: "s", text: "t" },
      });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    const third = await send();
    expect(third.status).toBe(429);
    expect(((await third.json()) as { code: string }).code).toBe("daily_send_cap_reached");
    // A refused reply-and-send leaves no draft behind.
    const reply = await agentFetch("/api/v1/messages/msg-1/reply", capped.token, {
      body: { text: "x" },
    });
    expect(reply.status).toBe(429);
    const drafts = (await (await agentFetch("/api/v1/drafts", capped.token)).json()) as {
      drafts: unknown[];
    };
    expect(drafts.drafts).toEqual([]);
  });

  it("a cap of 0 forbids sending but not drafting", async () => {
    const readOnly = await createApiToken("user-josh", { dailySendCap: 0 });
    const res = await agentFetch("/api/v1/send", readOnly.token, {
      body: { identityId: "idn-josh", to: ["a@b.com"], text: "t" },
    });
    expect(res.status).toBe(429);
    const draft = await agentFetch("/api/v1/drafts", readOnly.token, {
      body: { identityId: "idn-josh", to: ["a@b.com"], text: "t" },
    });
    expect(draft.status).toBe(201);
  });

  it("does not count webmail sends or failed validation", async () => {
    const bad = await post("/api/v1/send", { identityId: "idn-josh", to: ["not-an-address"] });
    expect(bad.status).toBe(400);
    const counter = await db
      .select()
      .from(rateLimitCounters)
      .where(eq(rateLimitCounters.key, `tok:send:${tokenId}`))
      .get();
    expect(counter).toBeUndefined();
  });
});

describe("membership revocation", () => {
  it("cuts a token off from a mailbox immediately", async () => {
    expect((await get("/api/v1/messages/msg-1")).status).toBe(200);
    await db
      .delete(mailboxMembers)
      .where(
        and(eq(mailboxMembers.mailboxId, "mbx-josh"), eq(mailboxMembers.userId, "user-josh")),
      );
    expect((await get("/api/v1/messages/msg-1")).status).toBe(404);
  });
});
