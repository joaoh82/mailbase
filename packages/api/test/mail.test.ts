import { SELF } from "cloudflare:test";
import { messages } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_BYTES,
  db,
  login,
  RAW_HTML_EMAIL,
  seed,
  type LoginResult,
} from "./seed";

let auth: LoginResult;

beforeEach(async () => {
  await seed();
  auth = await login();
});

function get(path: string) {
  return SELF.fetch(`http://webmail.local${path}`, {
    headers: { Cookie: auth.cookie },
  });
}

function post(path: string, body: unknown) {
  return SELF.fetch(`http://webmail.local${path}`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("mailboxes", () => {
  it("lists only the user's mailboxes, with unread counts", async () => {
    const res = await get("/api/mailboxes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mailboxes: unknown[] };
    expect(body.mailboxes).toEqual([
      {
        id: "mbx-josh",
        name: "josh",
        domain: "testdomain.com",
        address: "josh@testdomain.com",
        unread: 7, // 5 dated + thread reply + msg-rich; archived is read
      },
    ]);
  });

  it("paginates the folder listing newest-first with a stable cursor", async () => {
    const first = await get(
      "/api/mailboxes/mbx-josh/messages?folder=inbox&limit=3",
    );
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      messages: { id: string }[];
      nextCursor: string | null;
    };
    expect(page1.messages.map((m) => m.id)).toEqual([
      "msg-rich",
      "msg-thread-reply",
      "msg-5",
    ]);
    expect(page1.nextCursor).not.toBeNull();

    const second = await get(
      `/api/mailboxes/mbx-josh/messages?folder=inbox&limit=3&cursor=${page1.nextCursor}`,
    );
    const page2 = (await second.json()) as {
      messages: { id: string }[];
      nextCursor: string | null;
    };
    expect(page2.messages.map((m) => m.id)).toEqual([
      "msg-4",
      "msg-3",
      "msg-2",
    ]);

    const third = await get(
      `/api/mailboxes/mbx-josh/messages?folder=inbox&limit=3&cursor=${page2.nextCursor}`,
    );
    const page3 = (await third.json()) as {
      messages: { id: string }[];
      nextCursor: string | null;
    };
    expect(page3.messages.map((m) => m.id)).toEqual(["msg-1"]);
    expect(page3.nextCursor).toBeNull();
  });

  it("filters by folder and rejects unknown folders", async () => {
    const archive = await get(
      "/api/mailboxes/mbx-josh/messages?folder=archive",
    );
    const body = (await archive.json()) as { messages: { id: string }[] };
    expect(body.messages.map((m) => m.id)).toEqual(["msg-archived"]);

    const bogus = await get("/api/mailboxes/mbx-josh/messages?folder=junk");
    expect(bogus.status).toBe(400);
  });

  it("hides listings without membership", async () => {
    const res = await get("/api/mailboxes/mbx-other/messages");
    expect(res.status).toBe(404);
  });
});

describe("messages and threads", () => {
  it("returns message detail with body text and attachment metadata", async () => {
    const res = await get("/api/messages/msg-rich");
    expect(res.status).toBe(200);
    const { message } = (await res.json()) as {
      message: {
        subject: string;
        bodyText: string;
        attachments: { id: string; filename: string }[];
      };
    };
    expect(message.subject).toBe("Quarterly report");
    expect(message.bodyText).toContain("zanzibar");
    expect(message.attachments).toEqual([
      { id: "att-1", filename: "report.png", mimeType: "image/png", size: 12 },
    ]);
  });

  it("serves the HTML body lazily from the raw R2 blob", async () => {
    const res = await get("/api/messages/msg-rich/full");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string | null };
    expect(body.html).toContain("<b>zanzibar</b>");
    expect(body.html).toContain("tracker.example/pixel.png");
  });

  it("serves the raw .eml as a download", async () => {
    const res = await get("/api/messages/msg-rich/raw");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("message/rfc822");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toBe(RAW_HTML_EMAIL);
  });

  it("denies access to messages in foreign mailboxes", async () => {
    for (const path of [
      "/api/messages/msg-foreign",
      "/api/messages/msg-foreign/full",
      "/api/messages/msg-foreign/raw",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });

  it("returns a thread oldest-first with its messages", async () => {
    const res = await get("/api/threads/thr-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      thread: { id: string };
      messages: { id: string }[];
    };
    expect(body.thread.id).toBe("thr-1");
    expect(body.messages.map((m) => m.id)).toEqual([
      "msg-5",
      "msg-thread-reply",
    ]);
  });

  it("marks read/unread, stars, and moves messages", async () => {
    expect((await post("/api/messages/msg-1/read", { isRead: true })).status).toBe(200);
    let row = await db.select().from(messages).where(eq(messages.id, "msg-1")).get();
    expect(row!.isRead).toBe(true);

    expect((await post("/api/messages/msg-1/read", { isRead: false })).status).toBe(200);
    row = await db.select().from(messages).where(eq(messages.id, "msg-1")).get();
    expect(row!.isRead).toBe(false);

    expect((await post("/api/messages/msg-1/star", { isStarred: true })).status).toBe(200);
    row = await db.select().from(messages).where(eq(messages.id, "msg-1")).get();
    expect(row!.isStarred).toBe(true);

    expect((await post("/api/messages/msg-1/move", { folder: "archive" })).status).toBe(200);
    row = await db.select().from(messages).where(eq(messages.id, "msg-1")).get();
    expect(row!.folder).toBe("archive");

    expect((await post("/api/messages/msg-1/move", { folder: "trash" })).status).toBe(200);
    row = await db.select().from(messages).where(eq(messages.id, "msg-1")).get();
    expect(row!.folder).toBe("trash");
  });

  it("validates mutation payloads", async () => {
    expect((await post("/api/messages/msg-1/read", { isRead: "yes" })).status).toBe(400);
    expect((await post("/api/messages/msg-1/move", { folder: "spam" })).status).toBe(400);
    expect((await post("/api/messages/msg-foreign/read", { isRead: true })).status).toBe(404);
  });
});

describe("attachments", () => {
  it("mints a signed URL that downloads without a session", async () => {
    const minted = await get("/api/messages/msg-rich/attachments/att-1/url");
    expect(minted.status).toBe(200);
    const { url } = (await minted.json()) as { url: string };

    // No cookie: the signature alone authorizes the download.
    const res = await SELF.fetch(`http://webmail.local${url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="report.png"',
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ATTACHMENT_BYTES);
  });

  it("rejects tampered or expired signatures", async () => {
    const minted = await get("/api/messages/msg-rich/attachments/att-1/url");
    const { url } = (await minted.json()) as { url: string };

    const tampered = await SELF.fetch(
      `http://webmail.local${url.replace(/sig=./, "sig=0")}`,
    );
    expect(tampered.status).toBe(403);

    const expired = await SELF.fetch(
      `http://webmail.local${url.replace(/expires=\d+/, "expires=1000")}`,
    );
    expect(expired.status).toBe(403);

    const missing = await SELF.fetch(
      "http://webmail.local/api/attachments/att-1",
    );
    expect(missing.status).toBe(403);
  });

  it("refuses to mint URLs for attachments outside the user's mail", async () => {
    const res = await get("/api/messages/msg-foreign/attachments/att-1/url");
    expect(res.status).toBe(404);
  });
});

describe("search", () => {
  it("finds messages by body text, scoped to the mailbox", async () => {
    const res = await get("/api/mailboxes/mbx-josh/search?q=zanzibar");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { id: string }[] };
    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain("msg-2");
    expect(ids).toContain("msg-rich");
    // The other mailbox also mentions zanzibar; it must never leak in.
    expect(ids).not.toContain("msg-foreign");
  });

  it("matches the last token by prefix", async () => {
    const res = await get("/api/mailboxes/mbx-josh/search?q=zanzib");
    const body = (await res.json()) as { messages: { id: string }[] };
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("survives FTS5 syntax in the query", async () => {
    const res = await get(
      `/api/mailboxes/mbx-josh/search?q=${encodeURIComponent('"AND (zanzibar OR *')}`,
    );
    expect(res.status).toBe(200);
  });

  it("requires a query and membership", async () => {
    expect((await get("/api/mailboxes/mbx-josh/search?q=")).status).toBe(400);
    expect((await get("/api/mailboxes/mbx-other/search?q=x")).status).toBe(404);
  });
});
