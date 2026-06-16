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

  it("uses the white canvas by default (no bgMode) and in white mode", () => {
    const fallback = buildEmailSrcdoc("<p>hi</p>", { allowRemoteImages: false });
    const white = buildEmailSrcdoc("<p>hi</p>", {
      allowRemoteImages: false,
      bgMode: "white",
    });
    for (const doc of [fallback, white]) {
      expect(doc).toContain("background:#fff");
      expect(doc).toContain("color:#111");
      expect(doc).not.toContain("color-scheme:dark");
    }
  });

  it("uses a dark default canvas with light text in blended mode", () => {
    const doc = buildEmailSrcdoc("<p>hi</p>", {
      allowRemoteImages: false,
      bgMode: "blended",
    });
    expect(doc).toContain("background:#0f172a");
    expect(doc).toContain("color:#e2e8f0");
    expect(doc).toContain("color-scheme:dark");
    expect(doc).not.toContain("background:#fff");
  });

  it("keeps the body style a plain default — no !important fighting email CSS", () => {
    const doc = buildEmailSrcdoc("<p>hi</p>", {
      allowRemoteImages: false,
      bgMode: "blended",
    });
    // A bare body{} rule lets the email's own background/colors win.
    expect(doc).not.toContain("!important");
  });

  it("leaves the sandbox/CSP unchanged across background modes", () => {
    const white = buildEmailSrcdoc("<p>hi</p>", {
      allowRemoteImages: false,
      bgMode: "white",
    });
    const blended = buildEmailSrcdoc("<p>hi</p>", {
      allowRemoteImages: false,
      bgMode: "blended",
    });
    for (const doc of [white, blended]) {
      expect(doc).toContain("default-src 'none'");
      expect(doc).toContain("img-src data: cid:");
      expect(doc).toContain("form-action 'none'");
    }
  });
});
