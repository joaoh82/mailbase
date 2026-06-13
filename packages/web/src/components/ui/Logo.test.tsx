import { describe, expect, it } from "vitest";
import { Logo } from "./Logo";

describe("Logo", () => {
  it("is a renderable component", () => {
    expect(typeof Logo).toBe("function");
    const element = <Logo className="h-7 w-7" />;
    expect(element.type).toBe(Logo);
  });
});
