import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("is a renderable component", () => {
    expect(typeof App).toBe("function");
    const element = <App />;
    expect(element.type).toBe(App);
  });
});
