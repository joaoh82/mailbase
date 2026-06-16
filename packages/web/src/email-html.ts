// Builds the srcdoc for the sandboxed email iframe. Defense in depth
// (DESIGN.md §5/§6): the iframe carries sandbox="" with no allow-scripts and
// no allow-same-origin (unique opaque origin), and this CSP blocks every
// subresource except inline styles and data:/cid: images. Remote images are
// opt-in per message via the "load images" toggle, which only widens img-src.

import type { EmailBgMode } from "./lib/preferences";

// Body defaults per background mode (MAIL-15). These set the *default* canvas
// only — they're a plain `body{}` rule with no !important and no element
// targeting, so any color the email declares on its own markup wins. "white" is
// the historical, always-legible canvas. "blended" gives a dark default that
// matches the app chrome (slate-900 bg, slate-200 text) plus color-scheme:dark
// so the UA scrollbars/form controls and any prefers-color-scheme:dark email
// styles follow suit. Real HTML emails that set their own background stay on it;
// only unstyled / plaintext-ish mail picks up the dark default. Residual case:
// an email that sets dark text but no background can read dark-on-dark — the
// user flips back to "white" via the reading-pane toggle.
const BODY_STYLE: Record<EmailBgMode, string> = {
  white: "color:#111;background:#fff",
  blended: "color:#e2e8f0;background:#0f172a;color-scheme:dark",
};

export function buildEmailSrcdoc(
  html: string,
  options: { allowRemoteImages: boolean; bgMode?: EmailBgMode },
): string {
  const imgSrc = options.allowRemoteImages
    ? "img-src data: cid: https: http:"
    : "img-src data: cid:";
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    imgSrc,
    "form-action 'none'",
  ].join("; ");
  const bodyColors = BODY_STYLE[options.bgMode ?? "white"];
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    // Links escape the sandbox into a fresh tab; nothing navigates the app.
    '<base target="_blank">',
    `<style>body{margin:8px;font-family:system-ui,sans-serif;${bodyColors};word-break:break-word}</style>`,
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

/** Iframe sandbox attribute: no scripts, no same-origin; links may open tabs. */
export const EMAIL_IFRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";
