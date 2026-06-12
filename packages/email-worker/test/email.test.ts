import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

function makeMessage(): ForwardableEmailMessage {
  return {
    from: "sender@example.com",
    to: "someone@example.com",
    raw: new ReadableStream(),
    rawSize: 0,
    headers: new Headers(),
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

describe("email worker", () => {
  it("has D1 and R2 bindings configured", () => {
    expect(env.DB).toBeDefined();
    expect(env.MAIL_BUCKET).toBeDefined();
  });

  it("accepts an inbound message without throwing", async () => {
    const ctx = createExecutionContext();
    await worker.email(makeMessage(), env, ctx);
    await waitOnExecutionContext(ctx);
  });
});
