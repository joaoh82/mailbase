import { SELF } from "cloudflare:test";
import { drafts, messages } from "@mailbase/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_TOOLS } from "../src/agent/tools";
import { createApiToken, db, seed } from "./seed";

let token: string;

beforeEach(async () => {
  await seed();
  ({ token } = await createApiToken());
});

let nextId = 1;

async function rpc(method: string, params?: unknown, bearer = token) {
  const res = await SELF.fetch("http://webmail.local/api/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return res;
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: ToolResult; error?: unknown };
  return body;
}

async function callOk<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const body = await call(name, args);
  expect(body.result?.isError, JSON.stringify(body)).toBeFalsy();
  return JSON.parse(body.result!.content[0]!.text) as T;
}

describe("MCP endpoint", () => {
  it("initializes with only the bearer token (no session id)", async () => {
    const res = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as {
      result: { serverInfo: { name: string }; capabilities: { tools?: unknown } };
    };
    expect(body.result.serverInfo.name).toBe("mailbase");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("rejects requests without a valid token", async () => {
    expect((await rpc("tools/list", {}, "mb_bogus")).status).toBe(401);
  });

  it("lists every tool", async () => {
    const res = await rpc("tools/list", {});
    const body = (await res.json()) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(AGENT_TOOLS.map((t) => t.name).sort());
    for (const expected of [
      "list_mailboxes",
      "list_identities",
      "list_labels",
      "create_label",
      "list_messages",
      "search_messages",
      "check_new_mail",
      "get_message",
      "get_thread",
      "get_attachment_url",
      "mark_read",
      "set_starred",
      "move_message",
      "add_label",
      "remove_label",
      "list_drafts",
      "get_draft",
      "create_draft",
      "create_reply_draft",
      "update_draft",
      "delete_draft",
      "send_draft",
      "send_email",
      "reply_to_message",
      "forward_message",
      "list_events",
      "get_event",
      "rsvp_event",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("reads mail through tools", async () => {
    const { mailboxes } = await callOk<{ mailboxes: { id: string }[] }>("list_mailboxes");
    expect(mailboxes.map((m) => m.id)).toEqual(["mbx-josh"]);
    const list = await callOk<{ messages: { id: string }[] }>("list_messages", {
      mailboxId: "mbx-josh",
      limit: 3,
    });
    expect(list.messages).toHaveLength(3);
    const { message } = await callOk<{ message: { text: string } }>("get_message", {
      messageId: "msg-rich",
    });
    expect(message.text).toContain("zanzibar");
    const poll = await callOk<{ nextCursor: string }>("check_new_mail");
    expect(poll.nextCursor).toBeTruthy();
  });

  it("drafts a reply and sends it", async () => {
    const { draft } = await callOk<{ draft: { id: string; to: string[] } }>(
      "create_reply_draft",
      { messageId: "msg-rich", text: "On it." },
    );
    expect(draft.to).toEqual(["sender@remote.example"]);
    const sent = await callOk<{ message: { id: string; folder: string } }>("send_draft", {
      draftId: draft.id,
    });
    expect(sent.message.folder).toBe("sent");
    expect(await db.select().from(drafts).where(eq(drafts.id, draft.id)).get()).toBeUndefined();

    const email = await callOk<{ message: { id: string } }>("send_email", {
      identityId: "idn-josh",
      to: ["friend@gmail.com"],
      subject: "Hi",
      text: "Hello",
      attachments: [{ filename: "a.txt", contentType: "text/plain", contentBase64: "aGVsbG8=" }],
    });
    const row = await db.select().from(messages).where(eq(messages.id, email.message.id)).get();
    expect(row?.hasAttachments).toBe(true);
  });

  it("reports denials and bad input as tool errors", async () => {
    const foreign = await call("get_message", { messageId: "msg-foreign" });
    expect(foreign.result?.isError).toBe(true);
    expect(foreign.result?.content[0]?.text).toBe("Message not found");

    const sendAs = await call("send_email", { identityId: "idn-other", to: ["a@b.com"] });
    expect(sendAs.result?.isError).toBe(true);

    const invalid = await call("move_message", { messageId: "msg-1", folder: "spam" });
    expect(invalid.result?.isError ?? Boolean(invalid.error)).toBe(true);
  });

  it("reports the daily send cap as a tool error", async () => {
    const capped = await createApiToken("user-josh", { dailySendCap: 0 });
    const res = await rpc(
      "tools/call",
      { name: "send_email", arguments: { identityId: "idn-josh", to: ["a@b.com"], text: "t" } },
      capped.token,
    );
    const body = (await res.json()) as { result: ToolResult };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("daily_send_cap_reached");
  });
});
