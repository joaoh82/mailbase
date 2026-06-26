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
    mailboxDisplayName: "",
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

  // MAIL-11: when switching from a no-signature identity to a signed one on a
  // reply/forward, the signature must land ABOVE the quote even if the editor
  // re-serialized that quote with different (insignificant) whitespace, so the
  // exact-suffix match no longer holds.
  describe("tolerates quoted-region serialization drift", () => {
    it("inserts above a quote whose inner whitespace drifted", () => {
      const tracked = "<p>quoted</p>";
      // The editor padded the quote's text node with spaces.
      const body = `${COMPOSE_LEAD}<p> quoted </p>`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(`${COMPOSE_LEAD}<p>sig</p><p> quoted </p>`);
    });

    it("inserts above a multi-paragraph quote with whitespace between blocks", () => {
      const tracked = "<p>line1</p><p>line2</p>";
      // A newline crept in between the quoted paragraphs.
      const body = `${COMPOSE_LEAD}<p>line1</p>\n<p>line2</p>`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(`${COMPOSE_LEAD}<p>sig</p><p>line1</p>\n<p>line2</p>`);
    });

    it("inserts above the quote when an empty paragraph drifted into the boundary", () => {
      const tracked = "<p>quoted</p>";
      // The editor left an extra empty paragraph between the lead and the quote,
      // and re-spaced the quote itself.
      const body = `${COMPOSE_LEAD}<p></p><p>quoted </p>`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(`${COMPOSE_LEAD}<p></p><p>sig</p><p>quoted </p>`);
    });

    it("preserves the drifted quote verbatim — it is located, not rewritten", () => {
      const tracked = "<p>a</p><p>b</p>";
      const drifted = "<p>a</p>\n  <p>b</p>\n";
      const body = `${COMPOSE_LEAD}${drifted}`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(`${COMPOSE_LEAD}<p>sig</p>${drifted}`);
    });

    it("still removes an existing signature regardless of quote drift", () => {
      // Branch 1 (replace-in-place) is independent of the quote, so a present
      // previous signature is always swapped even if the quote drifted.
      const tracked = "<p>quoted</p>";
      const body = `${COMPOSE_LEAD}<p>old sig</p><p> quoted </p>`;
      const out = swapSignature(body, "<p>old sig</p>", "<p>new sig</p>", tracked);
      expect(out).toBe(`${COMPOSE_LEAD}<p>new sig</p><p> quoted </p>`);
    });

    it("falls back to appending when the quote was genuinely replaced, not just reformatted", () => {
      // No suffix matches the tracked quote, so we don't guess a boundary —
      // appending is the same safe fallback as before (no regression).
      const tracked = "<p>quoted</p>";
      const body = `${COMPOSE_LEAD}<p>totally different history</p>`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(`${COMPOSE_LEAD}<p>totally different history</p><p>sig</p>`);
    });
  });

  // MAIL-12: whitespace tolerance (MAIL-11) does not treat empty paragraphs as
  // insignificant, so a blank line added to / removed from the *middle* of the
  // quote would otherwise defeat the match and push the signature below it. The
  // signature must still land above the (verbatim) quote, and the leftmost-match
  // scan must not place it too high by swallowing leading empty paragraphs.
  describe("tolerates empty-paragraph drift inside the quoted region", () => {
    it("inserts above a quote that gained an empty paragraph mid-way", () => {
      const tracked = "<p>line1</p><p>line2</p>";
      // The editor inserted a blank line between the two quoted paragraphs.
      const drifted = "<p>line1</p><p></p><p>line2</p>";
      const body = `${COMPOSE_LEAD}${drifted}`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(`${COMPOSE_LEAD}<p>sig</p>${drifted}`);
    });

    it("inserts above a quote that lost an empty paragraph mid-way", () => {
      const tracked = "<p>line1</p><p></p><p>line2</p>";
      // The editor collapsed the blank line between the quoted paragraphs.
      const drifted = "<p>line1</p><p>line2</p>";
      const body = `${COMPOSE_LEAD}${drifted}`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(`${COMPOSE_LEAD}<p>sig</p>${drifted}`);
    });

    it("treats <p><br></p> as an empty paragraph for matching", () => {
      const tracked = "<p>line1</p><p>line2</p>";
      // Some editors render an empty paragraph as <p><br></p>.
      const drifted = "<p>line1</p><p><br></p><p>line2</p>";
      const body = `${COMPOSE_LEAD}${drifted}`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(`${COMPOSE_LEAD}<p>sig</p>${drifted}`);
    });

    it("handles empty-paragraph and whitespace drift together", () => {
      const tracked = "<p>line1</p><p>line2</p>";
      // A mid-quote blank line AND re-spacing of the surviving paragraphs.
      const drifted = "<p>line1 </p>\n<p></p><p> line2</p>";
      const body = `${COMPOSE_LEAD}${drifted}`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(`${COMPOSE_LEAD}<p>sig</p>${drifted}`);
    });

    it("preserves the drifted quote verbatim — empty paras are matched, not rewritten", () => {
      const tracked = "<p>a</p><p>b</p>";
      const drifted = "<p>a</p>\n<p></p>\n<p>b</p>\n";
      const body = `${COMPOSE_LEAD}${drifted}`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      // The output still contains the empty paragraph and the stray newlines.
      expect(out).toBe(`${COMPOSE_LEAD}<p>sig</p>${drifted}`);
    });

    it("does not place the signature above leading empty paragraphs of the head", () => {
      // Guard against the false-early boundary: collapsing empty paragraphs must
      // not let the scan match at index 0 (which would put the signature above
      // the compose lead-in). It lands above the first real quoted line, leaving
      // the head's empty paragraph(s) in place.
      const tracked = "<p>line1</p><p>line2</p>";
      const body = `${COMPOSE_LEAD}<p>line1</p><p></p><p>line2</p>`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(
        `${COMPOSE_LEAD}<p>sig</p><p>line1</p><p></p><p>line2</p>`,
      );
      // The compose lead-in is still the very first block, above the signature.
      expect(out.startsWith(`${COMPOSE_LEAD}<p>sig</p>`)).toBe(true);
    });

    it("keeps typed text and a boundary blank line above the swapped signature", () => {
      // Head = typed text + a blank line at the typed/quote boundary; quote then
      // gains a mid-quote blank line. Signature lands above the first real quoted
      // line, below everything the user typed.
      const tracked = "<p>line1</p><p>line2</p>";
      const head = "<p>hi there</p><p></p>";
      const drifted = "<p>line1</p><p></p><p>line2</p>";
      const body = `${head}${drifted}`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(`${head}<p>sig</p>${drifted}`);
    });

    it("still appends when the quote was genuinely replaced despite empty-para tolerance", () => {
      // Empty-paragraph tolerance must not turn a genuinely-replaced quote into a
      // false match — the safe append fallback still applies.
      const tracked = "<p>line1</p><p>line2</p>";
      const body = `${COMPOSE_LEAD}<p>different</p><p></p><p>history</p>`;
      const out = swapSignature(body, "", "<p>sig</p>", tracked);
      expect(out).toBe(
        `${COMPOSE_LEAD}<p>different</p><p></p><p>history</p><p>sig</p>`,
      );
    });
  });
});
