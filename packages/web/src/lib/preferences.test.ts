import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_MS,
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
