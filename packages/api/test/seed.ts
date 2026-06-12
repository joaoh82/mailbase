import { env } from "cloudflare:test";
import {
  addresses,
  attachments,
  domains,
  hashPassword,
  loginAttempts,
  mailboxes,
  mailboxMembers,
  messages,
  sessions,
  threads,
  users,
} from "@mailbase/shared";
import { drizzle } from "drizzle-orm/d1";

export const db = drizzle(env.DB);

export const TEST_PASSWORD = "correct horse battery staple";

// Deliberately weak argon2 params so each test login costs milliseconds.
// Production hashing uses ARGON2_DEFAULT_PARAMS; verifyPassword reads the
// params back from the PHC string, so both coexist.
export const TEST_HASH = hashPassword(TEST_PASSWORD, { m: 64, t: 1, p: 1 });

export const ATTACHMENT_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

export const RAW_HTML_EMAIL = [
  "From: Sender <sender@remote.example>",
  "To: josh@testdomain.com",
  "Subject: Quarterly report",
  "Date: Wed, 10 Jun 2026 09:00:00 +0000",
  "Message-ID: <q-report@remote.example>",
  'Content-Type: text/html; charset="utf-8"',
  "",
  "<html><body><p>The <b>zanzibar</b> numbers look great.</p>" +
    '<img src="https://tracker.example/pixel.png"></body></html>',
  "",
].join("\r\n");

// Two users with one mailbox each; josh's mailbox holds five dated inbox
// messages (msg-1 oldest … msg-5 newest), an archived message, a two-message
// thread, and one message with a raw blob + attachment in R2.
export async function seed() {
  // Reverse dependency order; wipes FTS via the delete triggers.
  await db.delete(attachments);
  await db.delete(messages);
  await db.delete(threads);
  await db.delete(mailboxMembers);
  await db.delete(addresses);
  await db.update(domains).set({ catchAllMailboxId: null });
  await db.delete(mailboxes);
  await db.delete(domains);
  await db.delete(sessions);
  await db.delete(loginAttempts);
  await db.delete(users);
  const list = await env.MAIL_BUCKET.list();
  if (list.objects.length > 0) {
    await env.MAIL_BUCKET.delete(list.objects.map((o) => o.key));
  }

  await db.insert(domains).values({ id: "dom-test", name: "testdomain.com" });
  await db.insert(users).values([
    {
      id: "user-josh",
      emailLogin: "josh@login.test",
      passwordHash: TEST_HASH,
      displayName: "Josh",
    },
    {
      id: "user-other",
      emailLogin: "other@login.test",
      passwordHash: TEST_HASH,
      displayName: "Other",
    },
  ]);
  await db.insert(mailboxes).values([
    { id: "mbx-josh", domainId: "dom-test", name: "josh" },
    { id: "mbx-other", domainId: "dom-test", name: "other" },
  ]);
  await db.insert(mailboxMembers).values([
    { mailboxId: "mbx-josh", userId: "user-josh", role: "owner" },
    { mailboxId: "mbx-other", userId: "user-other", role: "owner" },
  ]);
  await db.insert(threads).values({
    id: "thr-1",
    mailboxId: "mbx-josh",
    subjectNorm: "quarterly report",
    lastMessageAt: new Date(5000_000),
    messageCount: 2,
  });

  const baseMessage = {
    mailboxId: "mbx-josh",
    direction: "inbound" as const,
    fromAddr: "sender@remote.example",
    toAddrs: ["josh@testdomain.com"],
    folder: "inbox" as const,
  };
  // Two inserts: D1 allows at most 100 bound variables per statement.
  await db.insert(messages).values(
    [1, 2, 3, 4, 5].map((n) => ({
      ...baseMessage,
      id: `msg-${n}`,
      r2Key: `testdomain.com/mbx-josh/msg-${n}.eml`,
      threadId: n === 5 ? "thr-1" : null,
      subject: `Message ${n}`,
      snippet: `Snippet ${n}`,
      bodyText: `Body of message ${n}${n === 2 ? " mentions zanzibar twice: zanzibar" : ""}`,
      date: new Date(n * 1000_000),
      messageIdHeader: `msg-${n}@remote.example`,
    })),
  );
  await db.insert(messages).values([
    {
      ...baseMessage,
      id: "msg-thread-reply",
      r2Key: "testdomain.com/mbx-josh/msg-thread-reply.eml",
      threadId: "thr-1",
      subject: "Re: Message 5",
      snippet: "Reply snippet",
      bodyText: "Reply in thread",
      date: new Date(5000_000 + 1000),
      messageIdHeader: "msg-reply@remote.example",
    },
    {
      ...baseMessage,
      id: "msg-archived",
      r2Key: "testdomain.com/mbx-josh/msg-archived.eml",
      subject: "Old archived mail",
      bodyText: "Archived body",
      folder: "archive" as const,
      isRead: true,
      date: new Date(500_000),
      messageIdHeader: "msg-archived@remote.example",
    },
    {
      ...baseMessage,
      id: "msg-rich",
      r2Key: "testdomain.com/mbx-josh/msg-rich.eml",
      subject: "Quarterly report",
      bodyText: "The zanzibar numbers look great.",
      hasAttachments: true,
      date: new Date(6000_000),
      messageIdHeader: "q-report@remote.example",
    },
    {
      ...baseMessage,
      id: "msg-foreign",
      mailboxId: "mbx-other",
      r2Key: "testdomain.com/mbx-other/msg-foreign.eml",
      subject: "Private to other",
      bodyText: "Secret zanzibar content of the other mailbox",
      date: new Date(7000_000),
      messageIdHeader: "msg-foreign@remote.example",
    },
  ]);

  await db.insert(attachments).values({
    id: "att-1",
    messageId: "msg-rich",
    filename: "report.png",
    mimeType: "image/png",
    size: ATTACHMENT_BYTES.byteLength,
    r2Key: "attachments/testdomain.com/mbx-josh/msg-rich/att-1",
  });

  await env.MAIL_BUCKET.put(
    "testdomain.com/mbx-josh/msg-rich.eml",
    RAW_HTML_EMAIL,
    { httpMetadata: { contentType: "message/rfc822" } },
  );
  await env.MAIL_BUCKET.put(
    "attachments/testdomain.com/mbx-josh/msg-rich/att-1",
    ATTACHMENT_BYTES,
    { httpMetadata: { contentType: "image/png" } },
  );
}

export interface LoginResult {
  res: Response;
  cookie: string;
  csrfToken: string;
}

export async function login(
  email = "josh@login.test",
  password = TEST_PASSWORD,
): Promise<LoginResult> {
  const { SELF } = await import("cloudflare:test");
  const res = await SELF.fetch("http://webmail.local/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  let csrfToken = "";
  if (res.status === 200) {
    const body = (await res.clone().json()) as { csrfToken: string };
    csrfToken = body.csrfToken;
  }
  return { res, cookie, csrfToken };
}
