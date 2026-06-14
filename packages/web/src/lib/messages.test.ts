import { describe, expect, it } from "vitest";
import { isMessagePresent } from "./messages";

const page = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("isMessagePresent", () => {
  it("returns true when the id is still in the reloaded page", () => {
    expect(isMessagePresent(page, "b")).toBe(true);
  });

  it("returns false when the id was dropped by the reload", () => {
    expect(isMessagePresent(page, "z")).toBe(false);
  });

  it("returns false when nothing is selected", () => {
    expect(isMessagePresent(page, null)).toBe(false);
    expect(isMessagePresent(page, undefined)).toBe(false);
  });

  it("returns false for an empty page", () => {
    expect(isMessagePresent([], "a")).toBe(false);
  });
});
