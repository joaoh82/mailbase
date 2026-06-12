import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  addresses,
  attachments,
  domains,
  mailboxes,
  messages,
  threads,
} from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  ATTACHMENT_BYTES,
  MALFORMED_MIME,
  htmlEmailWithAttachment,
  makeMessage,
  multiRecipientEmail,
  plainTextEmail,
} from "./fixtures";

const db = drizzle(env.DB);

// Storage is shared across tests in this file: wipe D1 (FTS follows via the
// delete triggers) and R2 before reseeding.
async function resetStorage() {
  await db.delete(attachments);
  await db.delete(messages);
  await db.delete(threads);
  await db.delete(addresses);
  await db.update(domains).set({ catchAllMailboxId: null });
  await db.delete(mailboxes);
  await db.delete(domains);
  const list = await env.MAIL_BUCKET.list();
  if (list.objects.length > 0) {
    await env.MAIL_BUCKET.delete(list.objects.map((o) => o.key));
  }
}

// testdomain.com: josh@ + support@ are real, unknown local parts fall through
// to the catch-all mailbox. strict.example: reject_unknown is set.
beforeEach(async () => {
  await resetStorage();
  await db.insert(domains).values([
    { id: "dom-test", name: "testdomain.com", rejectUnknown: false },
    { id: "dom-strict", name: "strict.example", rejectUnknown: true },
  ]);
  await db.insert(mailboxes).values([
    { id: "mbx-josh", domainId: "dom-test", name: "josh" },
    { id: "mbx-support", domainId: "dom-test", name: "support" },
    { id: "mbx-catchall", domainId: "dom-test", name: "catchall" },
    { id: "mbx-owner", domainId: "dom-strict", name: "owner" },
  ]);
  await db
    .update(domains)
    .set({ catchAllMailboxId: "mbx-catchall" })
    .where(eq(domains.id, "dom-test"));
  await db.insert(addresses).values([
    { id: "addr-josh", domainId: "dom-test", localPart: "josh", mailboxId: "mbx-josh" },
    { id: "addr-jh", domainId: "dom-test", localPart: "jh", mailboxId: "mbx-josh" },
    { id: "addr-support", domainId: "dom-test", localPart: "support", mailboxId: "mbx-support" },
    { id: "addr-owner", domainId: "dom-strict", localPart: "owner", mailboxId: "mbx-owner" },
  ]);
});

async function deliver(raw: string, envelope?: { from?: string; to?: string }) {
  const message = makeMessage(raw, envelope);
  const ctx = createExecutionContext();
  await worker.email(message, env, ctx);
  await waitOnExecutionContext(ctx);
  return message;
}

describe("inbound pipeline", () => {
  it("has D1 and R2 bindings configured", () => {
    expect(env.DB).toBeDefined();
    expect(env.MAIL_BUCKET).toBeDefined();
  });

  it("stores a plain text email: D1 row, raw R2 object, thread, FTS", async () => {
    const raw = plainTextEmail({
      subject: "Lunch on zanzibar street?",
      body: "Meet at noon. The word zanzibar makes this searchable.",
    });
    const message = await deliver(raw);
    expect(message.rejected).toBeNull();

    const row = await db.select().from(messages).get();
    expect(row).toBeDefined();
    expect(row!.mailboxId).toBe("mbx-josh");
    expect(row!.direction).toBe("inbound");
    expect(row!.folder).toBe("inbox");
    expect(row!.fromAddr).toBe("sender@remote.example");
    expect(row!.toAddrs).toEqual(["josh@testdomain.com"]);
    expect(row!.subject).toBe("Lunch on zanzibar street?");
    expect(row!.bodyText).toContain("Meet at noon");
    expect(row!.snippet).toContain("Meet at noon");
    expect(row!.hasAttachments).toBe(false);
    expect(row!.size).toBeGreaterThan(0);
    expect(row!.messageIdHeader).toBe("plain-1@remote.example");
    expect(row!.date.toISOString()).toBe("2026-06-11T10:00:00.000Z");
    expect(row!.r2Key).toBe(`testdomain.com/mbx-josh/${row!.id}.eml`);

    const object = await env.MAIL_BUCKET.get(row!.r2Key);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe(raw);

    const thread = await db.select().from(threads).get();
    expect(thread).toBeDefined();
    expect(row!.threadId).toBe(thread!.id);
    expect(thread!.subjectNorm).toBe("lunch on zanzibar street?");
    expect(thread!.messageCount).toBe(1);

    const fts = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?",
    )
      .bind("zanzibar")
      .first<{ n: number }>();
    expect(fts?.n).toBe(1);
  });

  it("stores an HTML email with an attachment", async () => {
    await deliver(htmlEmailWithAttachment({ body: "Quarterly numbers attached." }));

    const row = await db.select().from(messages).get();
    expect(row).toBeDefined();
    expect(row!.hasAttachments).toBe(true);
    expect(row!.bodyText).toContain("Quarterly numbers attached.");

    const att = await db.select().from(attachments).get();
    expect(att).toBeDefined();
    expect(att!.messageId).toBe(row!.id);
    expect(att!.filename).toBe("logo.png");
    expect(att!.mimeType).toBe("image/png");
    expect(att!.size).toBe(ATTACHMENT_BYTES.byteLength);
    expect(att!.r2Key).toBe(
      `attachments/testdomain.com/mbx-josh/${row!.id}/${att!.id}`,
    );

    const object = await env.MAIL_BUCKET.get(att!.r2Key);
    expect(object).not.toBeNull();
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(
      ATTACHMENT_BYTES,
    );
  });

  it("delivers a multi-recipient message once per envelope recipient", async () => {
    // Email Routing invokes the worker once per RCPT TO; simulate both.
    const raw = multiRecipientEmail();
    await deliver(raw, { to: "josh@testdomain.com" });
    await deliver(raw, { to: "support@testdomain.com" });

    const rows = await db.select().from(messages).all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.mailboxId))).toEqual(
      new Set(["mbx-josh", "mbx-support"]),
    );
    for (const row of rows) {
      expect(row.toAddrs).toEqual([
        "josh@testdomain.com",
        "support@testdomain.com",
      ]);
      const object = await env.MAIL_BUCKET.get(row.r2Key);
      expect(object).not.toBeNull();
    }
  });

  it("stores one copy when recipients are aliases of the same mailbox", async () => {
    // josh@ and jh@ both map to mbx-josh; Email Routing delivers once per
    // envelope recipient, but the mailbox should only keep one copy.
    const raw = plainTextEmail({
      to: "josh@testdomain.com, jh@testdomain.com",
      messageId: "<alias-1@remote.example>",
    });
    await deliver(raw, { to: "josh@testdomain.com" });
    await deliver(raw, { to: "jh@testdomain.com" });

    expect(await db.select().from(messages).all()).toHaveLength(1);
    expect(await db.select().from(threads).all()).toHaveLength(1);
    expect((await env.MAIL_BUCKET.list()).objects).toHaveLength(1);
  });

  it("stores one copy even when alias deliveries run concurrently", async () => {
    // Two envelope deliveries of the same message racing past the pre-insert
    // duplicate check; the unique index must keep exactly one copy and the
    // loser must accept (not throw, which would make the sender retry).
    const raw = plainTextEmail({
      to: "josh@testdomain.com, jh@testdomain.com",
      messageId: "<race-1@remote.example>",
    });
    const first = makeMessage(raw, { to: "josh@testdomain.com" });
    const second = makeMessage(raw, { to: "jh@testdomain.com" });
    const ctx = createExecutionContext();
    await Promise.all([
      worker.email(first, env, ctx),
      worker.email(second, env, ctx),
    ]);
    await waitOnExecutionContext(ctx);

    expect(first.rejected).toBeNull();
    expect(second.rejected).toBeNull();
    expect(await db.select().from(messages).all()).toHaveLength(1);
    expect(await db.select().from(threads).all()).toHaveLength(1);
  });

  it("enforces one message per mailbox and Message-ID in the schema", async () => {
    const insert = (id: string) =>
      env.DB.prepare(
        "INSERT INTO messages (id, mailbox_id, r2_key, direction, from_addr, date, message_id_header) VALUES (?, 'mbx-josh', ?, 'inbound', 'a@b.c', 0, 'dup@x')",
      )
        .bind(id, `key-${id}`)
        .run();
    await insert("m1");
    await expect(insert("m2")).rejects.toThrow("UNIQUE constraint failed");
  });

  it("stores one copy when the sender retries an already-delivered message", async () => {
    const raw = plainTextEmail({ messageId: "<retry-1@remote.example>" });
    await deliver(raw);
    const retry = await deliver(raw);

    expect(retry.rejected).toBeNull();
    expect(await db.select().from(messages).all()).toHaveLength(1);
  });

  it("routes unknown recipients to the domain catch-all mailbox", async () => {
    const message = await deliver(
      plainTextEmail({ to: "anything@testdomain.com" }),
      { to: "anything@testdomain.com" },
    );
    expect(message.rejected).toBeNull();

    const row = await db.select().from(messages).get();
    expect(row!.mailboxId).toBe("mbx-catchall");
    expect(row!.r2Key).toContain("testdomain.com/mbx-catchall/");
  });

  it("rejects unknown recipients when the domain sets reject_unknown", async () => {
    const message = await deliver(
      plainTextEmail({ to: "nobody@strict.example" }),
      { to: "nobody@strict.example" },
    );
    expect(message.rejected).toBe("No such recipient: nobody@strict.example");
    expect(await db.select().from(messages).all()).toHaveLength(0);
    expect((await env.MAIL_BUCKET.list()).objects).toHaveLength(0);
  });

  it("still delivers to known addresses on a reject_unknown domain", async () => {
    const message = await deliver(
      plainTextEmail({ to: "owner@strict.example" }),
      { to: "owner@strict.example" },
    );
    expect(message.rejected).toBeNull();
    const row = await db.select().from(messages).get();
    expect(row!.mailboxId).toBe("mbx-owner");
  });

  it("rejects mail for domains it does not handle", async () => {
    const message = await deliver(plainTextEmail(), {
      to: "someone@unknown-domain.example",
    });
    expect(message.rejected).toContain("unknown-domain.example");
    expect(await db.select().from(messages).all()).toHaveLength(0);
  });

  it("stores malformed MIME without losing the raw message", async () => {
    const message = await deliver(MALFORMED_MIME, {
      from: "garbled@remote.example",
    });
    expect(message.rejected).toBeNull();

    const row = await db.select().from(messages).get();
    expect(row).toBeDefined();
    expect(row!.mailboxId).toBe("mbx-josh");
    // Whatever the parser salvaged, the raw bytes in R2 are verbatim.
    const object = await env.MAIL_BUCKET.get(row!.r2Key);
    expect(await object!.text()).toBe(MALFORMED_MIME);
  });

  it("threads a reply via In-Reply-To/References", async () => {
    await deliver(
      plainTextEmail({ subject: "Hello", messageId: "<orig-1@remote.example>" }),
    );
    await deliver(
      plainTextEmail({
        subject: "Totally rewritten subject",
        messageId: "<reply-1@elsewhere.example>",
        inReplyTo: "<orig-1@remote.example>",
        references: "<orig-1@remote.example>",
        date: "Thu, 11 Jun 2026 12:00:00 +0000",
      }),
    );

    const rows = await db.select().from(messages).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.threadId).toBe(rows[1]!.threadId);

    const thread = await db.select().from(threads).get();
    expect(thread!.messageCount).toBe(2);
    expect(thread!.lastMessageAt.toISOString()).toBe(
      "2026-06-11T12:00:00.000Z",
    );
  });

  it("threads a reply by normalized subject when references are missing", async () => {
    await deliver(
      plainTextEmail({ subject: "Hello", messageId: "<orig-2@remote.example>" }),
    );
    await deliver(
      plainTextEmail({
        subject: "Re: Hello",
        messageId: "<reply-2@elsewhere.example>",
      }),
    );

    const allThreads = await db.select().from(threads).all();
    expect(allThreads).toHaveLength(1);
    expect(allThreads[0]!.messageCount).toBe(2);
  });

  it("does not merge unrelated messages that share a subject", async () => {
    await deliver(
      plainTextEmail({ subject: "Hello", messageId: "<a@remote.example>" }),
    );
    await deliver(
      plainTextEmail({ subject: "Hello", messageId: "<b@other.example>" }),
    );

    expect(await db.select().from(threads).all()).toHaveLength(2);
  });

  it("throws on storage failure so the message is temp-failed, not lost", async () => {
    const brokenEnv = {
      ...env,
      MAIL_BUCKET: {
        async put() {
          throw new Error("simulated R2 outage");
        },
      } as unknown as R2Bucket,
    };
    const message = makeMessage(plainTextEmail());
    const ctx = createExecutionContext();
    await expect(worker.email(message, brokenEnv, ctx)).rejects.toThrow(
      "simulated R2 outage",
    );
    expect(message.rejected).toBeNull();
    expect(await db.select().from(messages).all()).toHaveLength(0);
  });
});
