import { describe, expect, it } from "vitest";
import { forwardBody, fwdSubject, quoteReplyBody, reSubject } from "../src/quote";

const message = {
  fromAddr: "alice@example.com",
  toAddrs: ["josh@example.com", "bob@example.com"],
  subject: "Plans",
  bodyText: "line one\nline two",
};

describe("reply/forward quoting", () => {
  it("prefixes Re:/Fwd: once", () => {
    expect(reSubject("Plans")).toBe("Re: Plans");
    expect(reSubject("RE: Plans")).toBe("RE: Plans");
    expect(fwdSubject("Plans")).toBe("Fwd: Plans");
    expect(fwdSubject("Fw: Plans")).toBe("Fw: Plans");
  });

  it("quotes every line of a reply", () => {
    expect(quoteReplyBody(message, "Mon")).toBe(
      "\n\nOn Mon, alice@example.com wrote:\n> line one\n> line two\n",
    );
  });

  it("builds the forwarded-message block", () => {
    expect(forwardBody(message, "Mon")).toBe(
      "\n\n---------- Forwarded message ----------\n" +
        "From: alice@example.com\nDate: Mon\nSubject: Plans\n" +
        "To: josh@example.com, bob@example.com\n\nline one\nline two\n",
    );
  });
});
