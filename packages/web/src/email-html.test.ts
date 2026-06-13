import { describe, expect, it } from "vitest";
import { buildEmailSrcdoc, EMAIL_IFRAME_SANDBOX } from "./email-html";

describe("buildEmailSrcdoc", () => {
  it("blocks remote images by default", () => {
    const doc = buildEmailSrcdoc("<p>hi</p>", { allowRemoteImages: false });
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("img-src data: cid:");
    expect(doc).not.toContain("img-src data: cid: https:");
    expect(doc).toContain("<p>hi</p>");
  });

  it("widens only img-src when remote images are allowed", () => {
    const doc = buildEmailSrcdoc("<p>hi</p>", { allowRemoteImages: true });
    expect(doc).toContain("img-src data: cid: https: http:");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("form-action 'none'");
  });

  it("opens links in a new tab via <base>", () => {
    const doc = buildEmailSrcdoc("", { allowRemoteImages: false });
    expect(doc).toContain('<base target="_blank">');
  });

  it("never grants the iframe scripts or same-origin access", () => {
    expect(EMAIL_IFRAME_SANDBOX).not.toContain("allow-scripts");
    expect(EMAIL_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  });
});
