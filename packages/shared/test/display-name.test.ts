import { describe, expect, it } from "vitest";
import { MAX_DISPLAY_NAME_LENGTH, sanitizeDisplayName } from "../src/index";

describe("sanitizeDisplayName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(sanitizeDisplayName("  Painel   News  ")).toBe("Painel News");
  });

  it("strips angle brackets so the From phrase stays well-formed", () => {
    expect(sanitizeDisplayName("Painel <News>")).toBe("Painel News");
  });

  it("strips control characters (header-injection defense)", () => {
    expect(sanitizeDisplayName("Evil\r\nBcc: x@y.com")).toBe("Evil Bcc: x@y.com");
    expect(sanitizeDisplayName("a\tb")).toBe("a b");
  });

  it("preserves non-ASCII names", () => {
    expect(sanitizeDisplayName("Café Müller")).toBe("Café Müller");
  });

  it("returns '' for empty / whitespace-only input", () => {
    expect(sanitizeDisplayName("")).toBe("");
    expect(sanitizeDisplayName("   ")).toBe("");
  });

  it("caps the length", () => {
    const long = "x".repeat(MAX_DISPLAY_NAME_LENGTH + 50);
    expect(sanitizeDisplayName(long)).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
  });
});
