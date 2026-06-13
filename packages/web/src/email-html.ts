// Builds the srcdoc for the sandboxed email iframe. Defense in depth
// (DESIGN.md §5/§6): the iframe carries sandbox="" with no allow-scripts and
// no allow-same-origin (unique opaque origin), and this CSP blocks every
// subresource except inline styles and data:/cid: images. Remote images are
// opt-in per message via the "load images" toggle, which only widens img-src.

export function buildEmailSrcdoc(
  html: string,
  options: { allowRemoteImages: boolean },
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
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    // Links escape the sandbox into a fresh tab; nothing navigates the app.
    '<base target="_blank">',
    "<style>body{margin:8px;font-family:system-ui,sans-serif;color:#111;background:#fff;word-break:break-word}</style>",
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

/** Iframe sandbox attribute: no scripts, no same-origin; links may open tabs. */
export const EMAIL_IFRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";
