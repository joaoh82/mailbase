// Outbound email HTML helpers. The compose editor produces HTML; before a
// message leaves the building we (a) sanitize that HTML down to a small,
// email-client-friendly allowlist and (b) derive a plaintext fallback so every
// message is a proper multipart/alternative that degrades gracefully.
//
// These are deliberately pure, DOM-free string functions: they run both in the
// Workers runtime (the API send path) and in plain Node (the web build and
// tests), neither of which has a DOM. The input here is our OWN editor output,
// not the hostile inbound HTML the message renderer guards against (DESIGN.md
// §5/§6) — so the goal is clean, predictable markup, not app-origin XSS
// defense. We still never trust the client: the API sanitizes on the way out
// regardless of what the browser actually sent.

/** Tags allowed in outbound HTML. Anything else is dropped (its text is kept). */
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "a",
]);

/** Allowed tags that carry no closing tag / children. */
const VOID_TAGS = new Set(["br"]);

/** URL schemes a sanitized `<a href>` may use; everything else is rejected. */
const SAFE_LINK_SCHEMES = ["http:", "https:", "mailto:"];

// --- shared tokenizer -------------------------------------------------------

interface TextToken {
  type: "text";
  value: string;
}
interface TagToken {
  type: "tag";
  name: string;
  isClose: boolean;
  attrs: Record<string, string>;
}
type Token = TextToken | TagToken;

const TAG_RE = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)\/?\s*>$/;
const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) {
    if (!m[0]) {
      ATTR_RE.lastIndex++; // guard against zero-width matches looping forever
      continue;
    }
    const name = m[1]?.toLowerCase();
    if (name && !(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

function parseTag(raw: string): TagToken | null {
  const m = TAG_RE.exec(raw);
  const name = m?.[2];
  if (!m || !name) return null;
  const isClose = m[1] === "/";
  return {
    type: "tag",
    name: name.toLowerCase(),
    isClose,
    attrs: isClose ? {} : parseAttrs(m[3] ?? ""),
  };
}

/** Index of the tag-closing `>` for the `<` at `start`, respecting quotes. */
function findTagEnd(s: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function tokenize(html: string): Token[] {
  // Drop comments and entire <script>/<style> elements (tags AND contents)
  // before tokenizing, so their text can never leak into the output.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\/?\s*(?:script|style)\b[^>]*>/gi, "");

  const tokens: Token[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const lt = cleaned.indexOf("<", i);
    if (lt === -1) {
      tokens.push({ type: "text", value: cleaned.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ type: "text", value: cleaned.slice(i, lt) });
    const end = findTagEnd(cleaned, lt);
    if (end === -1) {
      // Unterminated `<…`: treat the remainder as text.
      tokens.push({ type: "text", value: cleaned.slice(lt) });
      break;
    }
    const rawTag = cleaned.slice(lt, end + 1);
    const tag = parseTag(rawTag);
    // A non-tag `<…>` (e.g. `< b`) becomes literal text so it gets escaped.
    tokens.push(tag ?? { type: "text", value: rawTag });
    i = end + 1;
  }
  return tokens;
}

// --- entity handling --------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  tab: "\t",
  newline: "\n",
  nbsp: " ",
};

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Decode the entity forms an attacker might hide a URL scheme behind. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m: string, n: string) => {
      const decoded = NAMED_ENTITIES[n.toLowerCase()];
      return decoded ?? m;
    });
}

const STRAY_AMP = /&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g;

/** Escape a text node, leaving already-valid entities (e.g. `&amp;`) intact. */
function escapeText(text: string): string {
  return text
    .replace(STRAY_AMP, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a value for use inside a double-quoted attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(STRAY_AMP, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isSafeHref(value: string): boolean {
  // Decode entities and strip whitespace/control chars before checking the
  // scheme, so "java&#115;cript:" and "  javascript:" can't slip through.
  const v = decodeEntities(value)
    .replace(/[\u0000-\u0020]+/g, "")
    .toLowerCase();
  // Absolute http(s)/mailto only. Schemeless/relative hrefs are rejected too —
  // outbound email links should be fully qualified.
  return SAFE_LINK_SCHEMES.some((scheme) => v.startsWith(scheme));
}

// --- public API -------------------------------------------------------------

/**
 * Strip outbound HTML down to the allowlist: `p, br, b/strong, i/em, ul, ol,
 * li, h1–h3, a[href]`. Allowed tags are rebuilt from scratch (so every
 * attribute except a safe `href` on `<a>` is dropped — no styles, no event
 * handlers); disallowed tags are removed but their text content is preserved;
 * `<script>`/`<style>` and their contents are removed entirely.
 */
export function sanitizeOutboundHtml(html: string): string {
  if (!html) return "";
  let out = "";
  for (const token of tokenize(html)) {
    if (token.type === "text") {
      out += escapeText(token.value);
      continue;
    }
    if (!ALLOWED_TAGS.has(token.name)) continue; // drop tag, keep its children
    if (token.isClose) {
      if (!VOID_TAGS.has(token.name)) out += `</${token.name}>`;
      continue;
    }
    if (token.name === "a") {
      const href = token.attrs.href;
      out += href && isSafeHref(href) ? `<a href="${escapeAttr(href)}">` : "<a>";
    } else {
      out += `<${token.name}>`; // void tags (br) need no explicit close
    }
  }
  return out;
}

/**
 * Derive a readable plaintext fallback from HTML: block tags become line
 * breaks, list items get `- `/`1. ` markers, links render as `text (href)`,
 * entities are decoded, and unknown tags are stripped.
 */
export function htmlToText(html: string): string {
  if (!html) return "";
  let out = "";
  const listStack: { ordered: boolean; index: number }[] = [];
  let inLink = false;
  let linkHref = "";
  let linkText = "";

  const emit = (s: string) => {
    if (inLink) linkText += s;
    else out += s;
  };
  const flushLink = () => {
    const text = linkText.trim();
    const href = decodeEntities(linkHref).trim();
    if (href && href !== text) out += text ? `${text} (${href})` : href;
    else out += text;
    inLink = false;
    linkHref = "";
    linkText = "";
  };

  for (const token of tokenize(html)) {
    if (token.type === "text") {
      emit(decodeEntities(token.value));
      continue;
    }
    const { name, isClose } = token;
    if (isClose) {
      if (name === "a" && inLink) flushLink();
      else if (name === "p" || name === "h1" || name === "h2" || name === "h3")
        out += "\n\n";
      else if (name === "li") out += "\n";
      else if (name === "ul" || name === "ol") {
        listStack.pop();
        out += "\n";
      }
      continue;
    }
    if (name === "br") emit("\n");
    else if (name === "ul") listStack.push({ ordered: false, index: 0 });
    else if (name === "ol") listStack.push({ ordered: true, index: 0 });
    else if (name === "li") {
      const top = listStack[listStack.length - 1];
      if (top?.ordered) out += `${(top.index += 1)}. `;
      else out += "- ";
    } else if (name === "a") {
      inLink = true;
      linkHref = token.attrs.href ?? "";
      linkText = "";
    }
  }
  if (inLink) flushLink(); // unterminated <a>

  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Wrap plaintext as simple HTML for seeding the editor (e.g. a quoted reply
 * body). Blank lines start new paragraphs; single newlines become `<br>`.
 */
export function plainTextToHtml(text: string): string {
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map(
      (para) =>
        `<p>${escapeText(para).replace(/\r?\n/g, "<br>")}</p>`,
    )
    .join("");
}
