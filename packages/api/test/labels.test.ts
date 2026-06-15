import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { login, seed, type LoginResult } from "./seed";

// Labels (MAIL-16): mailbox-scoped, many-to-many tags over the folder model.
// The base seed gives josh (owner of mbx-josh, with inbox msg-1..msg-5 + more)
// and other (owner of mbx-other, with msg-foreign). Every label read/write must
// stay inside the caller's mailbox memberships — no cross-mailbox leakage.

function get(path: string, who: LoginResult) {
  return SELF.fetch(`http://webmail.local${path}`, {
    headers: { Cookie: who.cookie },
  });
}

function send(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
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

async function createLabel(
  who: LoginResult,
  mailboxId: string,
  name: string,
  color = "",
): Promise<string> {
  const res = await send("POST", "/api/labels", { mailboxId, name, color }, who);
  expect(res.status).toBe(201);
  const { label } = (await res.json()) as { label: { id: string } };
  return label.id;
}

beforeEach(seed);

describe("label CRUD + scoping", () => {
  it("creates, lists, renames, recolors, and deletes a label", async () => {
    const josh = await login();

    const createRes = await send(
      "POST",
      "/api/labels",
      { mailboxId: "mbx-josh", name: "Receipts", color: "#ef4444" },
      josh,
    );
    expect(createRes.status).toBe(201);
    const { label } = (await createRes.json()) as {
      label: { id: string; mailboxId: string; name: string; color: string };
    };
    expect(label).toMatchObject({
      mailboxId: "mbx-josh",
      name: "Receipts",
      color: "#ef4444",
    });

    // Listed for the mailbox.
    const listed = (await (
      await get("/api/labels?mailboxId=mbx-josh", josh)
    ).json()) as { labels: { id: string; name: string }[] };
    expect(listed.labels.map((l) => l.name)).toEqual(["Receipts"]);

    // Rename + recolor.
    expect(
      (await send("PATCH", `/api/labels/${label.id}`, { name: "Invoices" }, josh))
        .status,
    ).toBe(200);
    const recolor = await send(
      "PATCH",
      `/api/labels/${label.id}`,
      { color: "#22c55e" },
      josh,
    );
    expect(recolor.status).toBe(200);
    const after = (await (
      await get("/api/labels?mailboxId=mbx-josh", josh)
    ).json()) as { labels: { name: string; color: string }[] };
    expect(after.labels).toEqual([{ ...after.labels[0], name: "Invoices", color: "#22c55e" }]);

    // Delete.
    expect(
      (await send("DELETE", `/api/labels/${label.id}`, undefined, josh)).status,
    ).toBe(200);
    const empty = (await (
      await get("/api/labels?mailboxId=mbx-josh", josh)
    ).json()) as { labels: unknown[] };
    expect(empty.labels).toEqual([]);
  });

  it("rejects a blank name, an over-long name, a bad color, and a duplicate", async () => {
    const josh = await login();
    expect(
      (await send("POST", "/api/labels", { mailboxId: "mbx-josh", name: "  " }, josh))
        .status,
    ).toBe(400);
    expect(
      (
        await send(
          "POST",
          "/api/labels",
          { mailboxId: "mbx-josh", name: "x".repeat(65) },
          josh,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          "POST",
          "/api/labels",
          { mailboxId: "mbx-josh", name: "Bad", color: "red" },
          josh,
        )
      ).status,
    ).toBe(400);

    await createLabel(josh, "mbx-josh", "Dup");
    expect(
      (await send("POST", "/api/labels", { mailboxId: "mbx-josh", name: "Dup" }, josh))
        .status,
    ).toBe(409);
  });

  it("keeps labels scoped to mailbox membership (no cross-mailbox leakage)", async () => {
    const josh = await login();
    const other = await login("other@login.test");
    const joshLabel = await createLabel(josh, "mbx-josh", "Personal");

    // other is not a member of mbx-josh: cannot create in, list, patch, or
    // delete its labels — all indistinguishable from "not found".
    expect(
      (await send("POST", "/api/labels", { mailboxId: "mbx-josh", name: "Sneaky" }, other))
        .status,
    ).toBe(404);
    expect((await get("/api/labels?mailboxId=mbx-josh", other)).status).toBe(404);
    expect(
      (await send("PATCH", `/api/labels/${joshLabel}`, { name: "Hijack" }, other)).status,
    ).toBe(404);
    expect(
      (await send("DELETE", `/api/labels/${joshLabel}`, undefined, other)).status,
    ).toBe(404);

    // josh's label is untouched.
    const listed = (await (
      await get("/api/labels?mailboxId=mbx-josh", josh)
    ).json()) as { labels: { name: string }[] };
    expect(listed.labels.map((l) => l.name)).toEqual(["Personal"]);
  });
});

describe("apply / remove labels", () => {
  it("applies and removes a label on a message, idempotently, and shows it on reads", async () => {
    const josh = await login();
    const labelId = await createLabel(josh, "mbx-josh", "Important", "#f59e0b");

    // Apply, then apply again (idempotent).
    expect(
      (await send("PUT", `/api/messages/msg-1/labels/${labelId}`, undefined, josh)).status,
    ).toBe(200);
    expect(
      (await send("PUT", `/api/messages/msg-1/labels/${labelId}`, undefined, josh)).status,
    ).toBe(200);

    // Visible on the message detail read.
    const detail = (await (await get("/api/messages/msg-1", josh)).json()) as {
      message: { labels: { id: string; name: string; color: string }[] };
    };
    expect(detail.message.labels).toEqual([
      { id: labelId, mailboxId: "mbx-josh", name: "Important", color: "#f59e0b" },
    ]);

    // Remove, then remove again (idempotent no-op).
    expect(
      (await send("DELETE", `/api/messages/msg-1/labels/${labelId}`, undefined, josh)).status,
    ).toBe(200);
    expect(
      (await send("DELETE", `/api/messages/msg-1/labels/${labelId}`, undefined, josh)).status,
    ).toBe(200);
    const cleared = (await (await get("/api/messages/msg-1", josh)).json()) as {
      message: { labels: unknown[] };
    };
    expect(cleared.message.labels).toEqual([]);
  });

  it("refuses to apply a label from another mailbox, or to a message you can't see", async () => {
    const josh = await login();
    const other = await login("other@login.test");
    const otherLabel = await createLabel(other, "mbx-other", "Foreign");

    // josh cannot tag his own message with mbx-other's label (label not in the
    // message's mailbox) → 404.
    expect(
      (await send("PUT", `/api/messages/msg-1/labels/${otherLabel}`, undefined, josh)).status,
    ).toBe(404);

    // other cannot tag josh's message at all (message not accessible) → 404.
    const joshLabel = await createLabel(josh, "mbx-josh", "Mine");
    expect(
      (await send("PUT", `/api/messages/msg-1/labels/${joshLabel}`, undefined, other)).status,
    ).toBe(404);
  });

  it("drops a label off its messages when the label is deleted (cascade)", async () => {
    const josh = await login();
    const labelId = await createLabel(josh, "mbx-josh", "Temp");
    await send("PUT", `/api/messages/msg-1/labels/${labelId}`, undefined, josh);

    expect(
      (await send("DELETE", `/api/labels/${labelId}`, undefined, josh)).status,
    ).toBe(200);
    const detail = (await (await get("/api/messages/msg-1", josh)).json()) as {
      message: { labels: unknown[] };
    };
    expect(detail.message.labels).toEqual([]);
  });
});

describe("label-filtered message list", () => {
  it("returns only messages carrying the label, newest first, with chips on rows", async () => {
    const josh = await login();
    const labelId = await createLabel(josh, "mbx-josh", "Flagged", "#3b82f6");
    // msg-2 (date 2_000_000) and msg-4 (date 4_000_000) are inbox messages.
    await send("PUT", `/api/messages/msg-2/labels/${labelId}`, undefined, josh);
    await send("PUT", `/api/messages/msg-4/labels/${labelId}`, undefined, josh);

    const filtered = (await (
      await get(`/api/mailboxes/mbx-josh/messages?folder=inbox&labelId=${labelId}`, josh)
    ).json()) as { messages: { id: string; labels: { id: string }[] }[] };
    expect(filtered.messages.map((m) => m.id)).toEqual(["msg-4", "msg-2"]);
    // Each row carries the label chip.
    for (const m of filtered.messages) {
      expect(m.labels.map((l) => l.id)).toEqual([labelId]);
    }

    // The unfiltered inbox still carries labels on the tagged rows.
    const all = (await (
      await get("/api/mailboxes/mbx-josh/messages?folder=inbox", josh)
    ).json()) as { messages: { id: string; labels: { id: string }[] }[] };
    const tagged = all.messages.filter((m) => m.labels.length > 0).map((m) => m.id);
    expect(tagged.sort()).toEqual(["msg-2", "msg-4"]);
  });

  it("404s when filtering by a missing label or a label from another mailbox", async () => {
    const josh = await login();
    const other = await login("other@login.test");
    const otherLabel = await createLabel(other, "mbx-other", "Theirs");

    expect(
      (await get("/api/mailboxes/mbx-josh/messages?folder=inbox&labelId=nope", josh)).status,
    ).toBe(404);
    expect(
      (
        await get(
          `/api/mailboxes/mbx-josh/messages?folder=inbox&labelId=${otherLabel}`,
          josh,
        )
      ).status,
    ).toBe(404);
  });
});
