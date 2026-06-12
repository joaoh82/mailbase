import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("api worker", () => {
  it("has D1 and R2 bindings configured", () => {
    expect(env.DB).toBeDefined();
    expect(env.MAIL_BUCKET).toBeDefined();
  });

  it("GET /health returns ok", async () => {
    const response = await SELF.fetch("http://example.com/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
