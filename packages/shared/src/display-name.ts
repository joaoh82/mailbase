// Sanitize a mailbox display name before it is stored and later rendered into a
// From header (MAIL-22). The name becomes the phrase in `Name <addr@host>`, so
// we keep it well-formed and injection-safe:
//   - strip ASCII control characters (incl. CR/LF) -> spaces, so a hostile name
//     can never inject extra headers (defense in depth; the raw-email builder
//     also strips CR/LF at render time),
//   - drop the angle brackets reserved for the addr-spec so the phrase can't
//     break the `Name <addr>` structure,
//   - collapse runs of whitespace and trim,
//   - cap the length so a single name can't bloat every outgoing header.
// Non-ASCII (accents, etc.) is preserved; the raw-email builder RFC 2047
// encodes it when serialising the header.

export const MAX_DISPLAY_NAME_LENGTH = 200;

const CONTROL_CHARS = /[\x00-\x1f\x7f]+/g;
const ANGLE_BRACKETS = /[<>]/g;
const WHITESPACE_RUNS = /\s+/g;

export function sanitizeDisplayName(value: string): string {
  return value
    .replace(CONTROL_CHARS, " ")
    .replace(ANGLE_BRACKETS, "")
    .replace(WHITESPACE_RUNS, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
}
