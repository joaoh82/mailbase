import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_BG_MODE,
  DEFAULT_POLL_INTERVAL_MS,
  EMAIL_BG_OPTIONS,
  parseEmailBgMode,
  parsePollIntervalMs,
  POLL_INTERVAL_OPTIONS,
} from "./preferences";

describe("parsePollIntervalMs", () => {
  it("defaults when nothing is stored", () => {
    expect(parsePollIntervalMs(null)).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(parsePollIntervalMs("")).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(parsePollIntervalMs("   ")).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it("keeps a recognized value, including 0 (off)", () => {
    expect(parsePollIntervalMs("15000")).toBe(15_000);
    expect(parsePollIntervalMs("0")).toBe(0);
  });

  it("falls back for unrecognized or junk values", () => {
    expect(parsePollIntervalMs("45000")).toBe(DEFAULT_POLL_INTERVAL_MS); // old default, no longer offered
    expect(parsePollIntervalMs("abc")).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(parsePollIntervalMs("-1")).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it("round-trips every offered option", () => {
    for (const o of POLL_INTERVAL_OPTIONS) {
      expect(parsePollIntervalMs(String(o.value))).toBe(o.value);
    }
  });
});

describe("parseEmailBgMode", () => {
  it("defaults to white when nothing is stored", () => {
    expect(parseEmailBgMode(null)).toBe(DEFAULT_EMAIL_BG_MODE);
    expect(DEFAULT_EMAIL_BG_MODE).toBe("white");
  });

  it("keeps the blended mode", () => {
    expect(parseEmailBgMode("blended")).toBe("blended");
  });

  it("falls back to white for unrecognized or junk values", () => {
    expect(parseEmailBgMode("")).toBe("white");
    expect(parseEmailBgMode("dark")).toBe("white");
    expect(parseEmailBgMode("White")).toBe("white"); // case-sensitive
  });

  it("round-trips every offered option", () => {
    for (const o of EMAIL_BG_OPTIONS) {
      expect(parseEmailBgMode(o.value)).toBe(o.value);
    }
  });
});
