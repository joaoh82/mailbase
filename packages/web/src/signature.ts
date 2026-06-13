// Compose-time signature logic (MAIL-4), kept as pure string functions so it
// can be unit-tested without a DOM or a live editor. The composer wires these
// to the Tiptap editor; the real insert/replace happens by feeding the result
// of these functions back into the editor.
//
// Signatures are HTML, restricted to the same outbound allowlist the rest of
// the composer uses, and they are inserted into the HTML body. The plaintext
// fallback needs no special handling: the send path derives it from the final
// HTML (which already contains the signature) via htmlToText.

import type { Identity } from "./api";

/** A single empty paragraph — the space the user types into, above the signature. */
export const COMPOSE_LEAD = "<p></p>";

/**
 * The signature to use for a sending identity: its own signature wins; if that
 * is empty, the owning mailbox's default is used; if both are empty, none.
 * Mirrors the resolution described in DESIGN.md / the MAIL-4 spec.
 */
export function resolveSignature(identity: Identity | undefined): string {
  if (!identity) return "";
  return identity.signature || identity.mailboxSignature || "";
}

/**
 * Build the initial HTML body for a compose/reply/forward: an empty paragraph
 * for the user to type into, then the signature, then any quoted/forwarded
 * history. This matches Gmail's "signature above the quoted text" default —
 * for a fresh message `quotedHtml` is empty, so the signature sits at the
 * bottom.
 */
export function buildComposeBody(
  signatureHtml: string,
  quotedHtml: string,
): string {
  return COMPOSE_LEAD + (signatureHtml || "") + (quotedHtml || "");
}

/**
 * Collapse insignificant whitespace so two serializations of the same HTML
 * compare equal: runs of whitespace become a single space, and any space that
 * sits directly against a tag boundary (`<` or `>`) is dropped. Word spaces
 * inside text are preserved. This is used only to *locate* the quoted region —
 * never to rewrite it — so the original markup is always emitted unchanged.
 */
function normalizeForMatch(html: string): string {
  return html
    .replace(/\s+/g, " ")
    .replace(/ ?</g, "<")
    .replace(/> ?/g, ">")
    .trim();
}

/**
 * Find the index in `currentHtml` at which the quoted history begins, tolerant
 * of whitespace drift in how the editor re-serialized that quote. Returns -1
 * when the quoted region can't be confidently located (e.g. it was edited, not
 * just reformatted), so the caller can fall back to appending.
 *
 * The quoted region is a suffix that starts at a tag, so only `<` positions are
 * candidates. We take the earliest boundary whose normalized suffix equals the
 * normalized quote — that captures the whole quote rather than a trailing
 * fragment of it. Compose bodies are small and the matching boundary sits right
 * after the user's typed text, so this resolves in a handful of comparisons.
 */
function findQuotedStart(currentHtml: string, quotedHtml: string): number {
  if (!quotedHtml) return -1;
  // Exact suffix — the common, no-drift case. Keeps the quoted region byte-exact.
  if (currentHtml.endsWith(quotedHtml)) {
    return currentHtml.length - quotedHtml.length;
  }
  const target = normalizeForMatch(quotedHtml);
  if (!target) return -1;
  for (let i = 0; i < currentHtml.length; i++) {
    // Normalizing only removes characters, so once the remaining suffix is
    // shorter than the normalized quote it can never match — stop early.
    if (currentHtml.length - i < target.length) break;
    if (currentHtml[i] !== "<") continue;
    if (normalizeForMatch(currentHtml.slice(i)) === target) return i;
  }
  return -1;
}

/**
 * Swap the signature in an existing body when the From identity changes.
 *
 * All arguments are expected in the same normalized HTML space (the composer
 * passes the editor's current HTML run through `sanitizeOutboundHtml`, and the
 * signatures/quote it tracks are likewise sanitized) so the previously-inserted
 * signature can be found and replaced exactly once — never stacked.
 *
 * - If the previous signature is present, it is replaced in place.
 * - Otherwise the new signature is inserted just above the quoted history (or
 *   appended for a fresh message). The quoted region is located tolerantly, so
 *   the signature still lands above the quote even if the editor reformatted
 *   that quote's whitespace since it was first inserted. If there is no previous
 *   signature to find and nothing new to insert, the body is returned unchanged.
 */
export function swapSignature(
  currentHtml: string,
  prevSignatureHtml: string,
  nextSignatureHtml: string,
  quotedHtml: string,
): string {
  if (prevSignatureHtml && currentHtml.includes(prevSignatureHtml)) {
    // Replace the first occurrence only. The function form of replace avoids
    // any `$`-pattern interpretation of the new signature's HTML.
    return currentHtml.replace(prevSignatureHtml, () => nextSignatureHtml);
  }
  if (!nextSignatureHtml) return currentHtml;
  const quotedStart = findQuotedStart(currentHtml, quotedHtml);
  if (quotedStart >= 0) {
    return (
      currentHtml.slice(0, quotedStart) +
      nextSignatureHtml +
      currentHtml.slice(quotedStart)
    );
  }
  return currentHtml + nextSignatureHtml;
}
