import { SELF } from "cloudflare:test";
import {
  base64ToBytes,
  hmacSha256Base64,
  mailboxes,
  messages,
} from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, login, seed, type LoginResult } from "./seed";

const WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldA";

let auth: LoginResult;

beforeEach(async () => {
  await seed();
  auth = await login();
});

function post(path: string, body: unknown, who: LoginResult = auth) {
  return SELF.fetch(`http://webmail.local${path}`, {
    method: "POST",
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

async function rawOf(messageId: string): Promise<string> {
  const res = await get(`/api/messages/${messageId}/raw`);
  expect(res.status).toBe(200);
  return res.text();
}

describe("identities", () => {
  it("lists the signed-in user's send-as identities", async () => {
    const res = await get("/api/send/identities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identities: unknown[] };
    expect(body.identities).toEqual([
      {
        id: "idn-josh",
        address: "josh@testdomain.com",
        displayName: "Josh",
        mailboxDisplayName: "",
        mailboxId: "mbx-josh",
        signature: "",
        mailboxSignature: "",
      },
    ]);
  });

  it("exposes the owning mailbox's From name for the composer", async () => {
    await db
      .update(mailboxes)
      .set({ displayName: "Painel News" })
      .where(eq(mailboxes.id, "mbx-josh"));
    const res = await get("/api/send/identities");
    const body = (await res.json()) as {
      identities: { mailboxDisplayName: string }[];
    };
    expect(body.identities[0]?.mailboxDisplayName).toBe("Painel News");
  });
});

describe("sending", () => {
  it("sends, stores a Sent copy in D1 + R2, and indexes it", async () => {
    const res = await post("/api/send", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      cc: ["cc@gmail.com"],
      subject: "Hello there",
      text: "The body mentions wakanda.",
    });
    expect(res.status).toBe(201);
    const { message, providerMessageId } = (await res.json()) as {
      message: { id: string; direction: string; folder: string; fromAddr: string };
      providerMessageId: string;
    };
    expect(message.direction).toBe("outbound");
    expect(message.folder).toBe("sent");
    expect(message.fromAddr).toBe("josh@testdomain.com");
    expect(providerMessageId).toMatch(/^mock-/);

    // Shows up in the Sent folder.
    const sent = await get("/api/mailboxes/mbx-josh/messages?folder=sent");
    const list = (await sent.json()) as { messages: { id: string }[] };
    expect(list.messages.map((m) => m.id)).toContain(message.id);

    // Stored raw .eml carries the right envelope headers and a Message-ID.
    const raw = await rawOf(message.id);
    expect(raw).toContain("From: Josh <josh@testdomain.com>");
    expect(raw).toContain("To: friend@gmail.com");
    expect(raw).toContain("Cc: cc@gmail.com");
    expect(raw).toContain("Subject: Hello there");
    expect(raw).toMatch(/Message-ID: <[0-9a-f-]+@testdomain\.com>/);

    // Searchable like any other message.
    const search = await get("/api/mailboxes/mbx-josh/search?q=wakanda");
    const found = (await search.json()) as { messages: { id: string }[] };
    expect(found.messages.map((m) => m.id)).toContain(message.id);
  });

  it("uses the mailbox's From name over the sender's identity name (MAIL-22)", async () => {
    // The shared inbox has a display name; the sender's own identity is "Josh".
    await db
      .update(mailboxes)
      .set({ displayName: "Painel News" })
      .where(eq(mailboxes.id, "mbx-josh"));

    const res = await post("/api/send", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "Shared inbox",
      text: "Body",
    });
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as { message: { id: string } };
    const raw = await rawOf(message.id);
    expect(raw).toContain("From: Painel News <josh@testdomain.com>");
    expect(raw).not.toContain("From: Josh <josh@testdomain.com>");
  });

  it("sends an HTML body as sanitized multipart/alternative with a text fallback", async () => {
    const res = await post("/api/send", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "Formatted hello",
      // When HTML is present it is the source of truth; this client text is
      // ignored in favour of a plaintext alternative derived from the HTML.
      text: "ignored client text",
      html:
        "<h1>Hi</h1><p><strong>Bold</strong> and a " +
        '<a href="https://example.com" onclick="steal()">link</a>.</p>' +
        "<ul><li>one</li><li>two</li></ul>" +
        '<script>alert(1)</script><img src=x onerror="x()">',
    });
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as { message: { id: string } };

    // Stored raw .eml carries both body parts.
    const raw = await rawOf(message.id);
    expect(raw).toContain("multipart/alternative");

    // /full parses the stored raw back into html + text via postal-mime.
    const full = await get(`/api/messages/${message.id}/full`);
    const { html, text } = (await full.json()) as {
      html: string | null;
      text: string | null;
    };

    // Formatting survives; hostile constructs are stripped on the way out.
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("steal");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");

    // The plaintext alternative is derived from the HTML, not the client text.
    expect(text).toContain("Bold and a link (https://example.com)");
    expect(text).toContain("- one");
    expect(text).toContain("- two");
    expect(text).not.toContain("ignored client text");
  });

  it("threads a reply into the parent's thread with reply headers", async () => {
    const res = await post("/api/send", {
      identityId: "idn-josh",
      to: ["sender@remote.example"],
      subject: "Re: Message 5",
      text: "Replying now.",
      inReplyTo: "msg-5",
    });
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as {
      message: { id: string; threadId: string };
    };
    expect(message.threadId).toBe("thr-1");

    const raw = await rawOf(message.id);
    expect(raw).toContain("In-Reply-To: <msg-5@remote.example>");
    expect(raw).toContain("References: <msg-5@remote.example>");

    // The thread now lists the original, its reply, and our outbound message.
    const thread = await get("/api/threads/thr-1");
    const body = (await thread.json()) as { messages: { id: string }[] };
    expect(body.messages.map((m) => m.id)).toContain(message.id);
  });

  it("threads a 'Re:' subject into a same-subject thread without inReplyTo", async () => {
    // thr-1 already has subject_norm "quarterly report" in mbx-josh.
    const res = await post("/api/send", {
      identityId: "idn-josh",
      to: ["sender@remote.example"],
      subject: "Re: Quarterly report",
      text: "subject-only threading",
    });
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as {
      message: { threadId: string };
    };
    expect(message.threadId).toBe("thr-1");
  });

  it("strips CR/LF from headers so the subject cannot inject one", async () => {
    const res = await post("/api/send", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "Hi there\r\nBcc: evil@evil.com",
      text: "x",
    });
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as { message: { id: string } };
    const raw = await rawOf(message.id);
    // The injected header must not exist as its own line…
    expect(raw).not.toMatch(/^Bcc: evil@evil\.com/m);
    // …and the subject is collapsed onto one line.
    expect(raw).toContain("Subject: Hi there Bcc: evil@evil.com");
  });

  it("refuses to send as an identity the user does not own", async () => {
    const res = await post("/api/send", {
      identityId: "idn-other",
      to: ["friend@gmail.com"],
      subject: "Spoof",
      text: "nope",
    });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown identity, bad recipients, and empty recipients", async () => {
    expect(
      (await post("/api/send", { identityId: "nope", to: ["a@b.com"] })).status,
    ).toBe(403);
    expect(
      (
        await post("/api/send", {
          identityId: "idn-josh",
          to: ["not-an-email"],
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/api/send", { identityId: "idn-josh", to: [] })).status,
    ).toBe(400);
  });

  it("404s a reply whose parent is in another user's mailbox", async () => {
    const res = await post("/api/send", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "Re: Private",
      text: "x",
      inReplyTo: "msg-foreign",
    });
    expect(res.status).toBe(404);
  });
});

describe("attachments", () => {
  it("uploads to R2 and attaches it to the sent message", async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new File([new Uint8Array([1, 2, 3, 4, 5])], "notes.bin", {
        type: "application/octet-stream",
      }),
    );
    const up = await SELF.fetch("http://webmail.local/api/send/uploads", {
      method: "POST",
      headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrfToken },
      body: fd,
    });
    expect(up.status).toBe(200);
    const { uploadId, filename } = (await up.json()) as {
      uploadId: string;
      filename: string;
    };
    expect(filename).toBe("notes.bin");

    const res = await post("/api/send", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "With a file",
      text: "see attached",
      uploadIds: [uploadId],
    });
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as {
      message: {
        id: string;
        hasAttachments: boolean;
        attachments: { filename: string; size: number }[];
      };
    };
    expect(message.hasAttachments).toBe(true);
    expect(message.attachments).toEqual([
      { id: expect.any(String), filename: "notes.bin", mimeType: "application/octet-stream", size: 5 },
    ]);
  });

  it("rejects a stale/forged upload reference", async () => {
    const res = await post("/api/send", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "x",
      text: "x",
      uploadIds: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(res.status).toBe(400);
  });
});

describe("delivery webhooks", () => {
  function svixHeaders(id: string, body: string): Record<string, string> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = base64ToBytes(WEBHOOK_SECRET.replace(/^whsec_/, ""));
    const signature = hmacSha256Base64(key, `${id}.${timestamp}.${body}`);
    return {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    };
  }

  async function sendOne(): Promise<{ id: string; providerMessageId: string }> {
    const res = await post("/api/send", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "Track me",
      text: "hi",
    });
    const { message, providerMessageId } = (await res.json()) as {
      message: { id: string };
      providerMessageId: string;
    };
    return { id: message.id, providerMessageId };
  }

  it("flags the affected message on a bounce", async () => {
    const { id, providerMessageId } = await sendOne();
    const body = JSON.stringify({
      type: "email.bounced",
      data: { email_id: providerMessageId },
    });
    const res = await SELF.fetch("http://webmail.local/api/webhooks/resend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...svixHeaders("msg_bounce_1", body),
      },
      body,
    });
    expect(res.status).toBe(200);

    const row = await db.select().from(messages).where(eq(messages.id, id)).get();
    expect(row!.deliveryStatus).toBe("bounced");
  });

  it("flags a complaint too", async () => {
    const { id, providerMessageId } = await sendOne();
    const body = JSON.stringify({
      type: "email.complained",
      data: { email_id: providerMessageId },
    });
    const res = await SELF.fetch("http://webmail.local/api/webhooks/resend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...svixHeaders("msg_complaint_1", body),
      },
      body,
    });
    expect(res.status).toBe(200);
    const row = await db.select().from(messages).where(eq(messages.id, id)).get();
    expect(row!.deliveryStatus).toBe("complained");
  });

  it("rejects an invalid signature and changes nothing", async () => {
    const { id, providerMessageId } = await sendOne();
    const body = JSON.stringify({
      type: "email.bounced",
      data: { email_id: providerMessageId },
    });
    const res = await SELF.fetch("http://webmail.local/api/webhooks/resend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": "msg_x",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,deadbeef",
      },
      body,
    });
    expect(res.status).toBe(401);
    const row = await db.select().from(messages).where(eq(messages.id, id)).get();
    expect(row!.deliveryStatus).toBe("");
  });
});
