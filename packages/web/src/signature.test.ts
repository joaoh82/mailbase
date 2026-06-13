import { describe, expect, it } from "vitest";
import type { Identity } from "./api";
import {
  buildComposeBody,
  COMPOSE_LEAD,
  resolveSignature,
  swapSignature,
} from "./signature";

function identity(overrides: Partial<Identity>): Identity {
  return {
    id: "idn",
    address: "me@example.com",
    displayName: "Me",
    mailboxId: "mbx",
    signature: "",
    mailboxSignature: "",
    ...overrides,
  };
}

describe("resolveSignature", () => {
  it("prefers the identity's own signature", () => {
    expect(
      resolveSignature(
        identity({ signature: "<p>own</p>", mailboxSignature: "<p>box</p>" }),
      ),
    ).toBe("<p>own</p>");
  });

  it("falls back to the mailbox default when the identity has none", () => {
    expect(
      resolveSignature(identity({ signature: "", mailboxSignature: "<p>box</p>" })),
    ).toBe("<p>box</p>");
  });

  it("is empty when neither is set", () => {
    expect(resolveSignature(identity({}))).toBe("");
  });

  it("is empty for a missing identity", () => {
    expect(resolveSignature(undefined)).toBe("");
  });
});

describe("buildComposeBody", () => {
  it("puts the signature below the lead-in for a fresh message", () => {
    expect(buildComposeBody("<p>sig</p>", "")).toBe(`${COMPOSE_LEAD}<p>sig</p>`);
  });

  it("places the signature above the quoted history for a reply", () => {
    expect(buildComposeBody("<p>sig</p>", "<p>quoted</p>")).toBe(
      `${COMPOSE_LEAD}<p>sig</p><p>quoted</p>`,
    );
  });

  it("omits the signature when there is none", () => {
    expect(buildComposeBody("", "<p>quoted</p>")).toBe(
      `${COMPOSE_LEAD}<p>quoted</p>`,
    );
  });
});

describe("swapSignature", () => {
  it("replaces an existing signature in place without stacking", () => {
    const body = `${COMPOSE_LEAD}<p>typed</p><p>old sig</p>`;
    const out = swapSignature(body, "<p>old sig</p>", "<p>new sig</p>", "");
    expect(out).toBe(`${COMPOSE_LEAD}<p>typed</p><p>new sig</p>`);
    expect(out).not.toContain("old sig");
  });

  it("keeps the signature above the quoted history when swapping in a reply", () => {
    const quoted = "<p>quoted</p>";
    const body = `${COMPOSE_LEAD}<p>old</p>${quoted}`;
    const out = swapSignature(body, "<p>old</p>", "<p>new</p>", quoted);
    expect(out).toBe(`${COMPOSE_LEAD}<p>new</p>${quoted}`);
  });

  it("inserts above the quoted history when there was no prior signature", () => {
    const quoted = "<p>quoted</p>";
    const body = `${COMPOSE_LEAD}${quoted}`;
    const out = swapSignature(body, "", "<p>sig</p>", quoted);
    expect(out).toBe(`${COMPOSE_LEAD}<p>sig</p>${quoted}`);
  });

  it("appends when there is no prior signature and no quoted history", () => {
    const body = `${COMPOSE_LEAD}<p>typed</p>`;
    expect(swapSignature(body, "", "<p>sig</p>", "")).toBe(
      `${COMPOSE_LEAD}<p>typed</p><p>sig</p>`,
    );
  });

  it("removes the signature when switching to an identity that has none", () => {
    const body = `${COMPOSE_LEAD}<p>typed</p><p>sig</p>`;
    expect(swapSignature(body, "<p>sig</p>", "", "")).toBe(
      `${COMPOSE_LEAD}<p>typed</p>`,
    );
  });

  it("leaves the body unchanged when there is nothing to do", () => {
    const body = `${COMPOSE_LEAD}<p>typed</p>`;
    expect(swapSignature(body, "", "", "")).toBe(body);
  });

  it("never stacks across a chain of identity switches", () => {
    let body = buildComposeBody("<p>A</p>", "");
    body = swapSignature(body, "<p>A</p>", "<p>B</p>", "");
    body = swapSignature(body, "<p>B</p>", "<p>C</p>", "");
    expect(body).toBe(`${COMPOSE_LEAD}<p>C</p>`);
    expect(body).not.toContain("<p>A</p>");
    expect(body).not.toContain("<p>B</p>");
  });

  it("does not misinterpret `$` patterns in the new signature", () => {
    const body = `${COMPOSE_LEAD}<p>old</p>`;
    const out = swapSignature(body, "<p>old</p>", "<p>Cost: $5 & $$</p>", "");
    expect(out).toBe(`${COMPOSE_LEAD}<p>Cost: $5 & $$</p>`);
  });
});
