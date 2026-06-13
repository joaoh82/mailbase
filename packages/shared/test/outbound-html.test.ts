import { describe, expect, it } from "vitest";
import {
  htmlToText,
  plainTextToHtml,
  sanitizeOutboundHtml,
} from "../src/outbound-html";

describe("sanitizeOutboundHtml — allowlist", () => {
  it("keeps the formatting tags we support", () => {
    const html =
      "<p><strong>Bold</strong> and <em>italic</em> and <b>b</b> and <i>i</i></p>";
    expect(sanitizeOutboundHtml(html)).toBe(html);
  });

  it("keeps bullet lists, numbered lists, and headings", () => {
    expect(sanitizeOutboundHtml("<ul><li>one</li><li>two</li></ul>")).toBe(
      "<ul><li>one</li><li>two</li></ul>",
    );
    expect(sanitizeOutboundHtml("<ol><li>one</li></ol>")).toBe(
      "<ol><li>one</li></ol>",
    );
    expect(
      sanitizeOutboundHtml("<h1>A</h1><h2>B</h2><h3>C</h3>"),
    ).toBe("<h1>A</h1><h2>B</h2><h3>C</h3>");
  });

  it("keeps line breaks without emitting a closing tag", () => {
    expect(sanitizeOutboundHtml("<p>a<br>b</p>")).toBe("<p>a<br>b</p>");
    expect(sanitizeOutboundHtml("<p>a<br/>b</p>")).toBe("<p>a<br>b</p>");
    expect(sanitizeOutboundHtml("a<br></br>b")).toBe("a<br>b");
  });

  it("keeps safe links and rebuilds them with only the href", () => {
    expect(
      sanitizeOutboundHtml('<a href="https://example.com">x</a>'),
    ).toBe('<a href="https://example.com">x</a>');
    expect(sanitizeOutboundHtml('<a href="mailto:a@b.com">mail</a>')).toBe(
      '<a href="mailto:a@b.com">mail</a>',
    );
    // rel / target / class etc. are dropped — only href survives.
    expect(
      sanitizeOutboundHtml(
        '<a href="https://x.io" rel="noopener" target="_blank" class="z">x</a>',
      ),
    ).toBe('<a href="https://x.io">x</a>');
  });

  it("preserves ampersands in href query strings (escaped, not decoded)", () => {
    expect(
      sanitizeOutboundHtml('<a href="https://x.io/?a=1&b=2">x</a>'),
    ).toBe('<a href="https://x.io/?a=1&amp;b=2">x</a>');
  });
});

describe("sanitizeOutboundHtml — stripping hostile / unknown content", () => {
  it("removes <script> and <style> elements and their contents entirely", () => {
    expect(sanitizeOutboundHtml("<p>hi</p><script>alert(1)</script>")).toBe(
      "<p>hi</p>",
    );
    expect(
      sanitizeOutboundHtml("<style>p{color:red}</style><p>hi</p>"),
    ).toBe("<p>hi</p>");
    expect(
      sanitizeOutboundHtml('<p>a<script src="x.js"></script>b</p>'),
    ).toBe("<p>ab</p>");
  });

  it("drops disallowed tags but keeps their text content", () => {
    expect(sanitizeOutboundHtml("<div>hi</div>")).toBe("hi");
    expect(sanitizeOutboundHtml("<table><tr><td>x</td></tr></table>")).toBe(
      "x",
    );
    expect(sanitizeOutboundHtml("<blockquote>q</blockquote>")).toBe("q");
  });

  it("drops elements that carry an attack via attributes", () => {
    expect(sanitizeOutboundHtml('<img src="x" onerror="alert(1)">')).toBe("");
    expect(
      sanitizeOutboundHtml('<iframe src="javascript:alert(1)"></iframe>'),
    ).toBe("");
  });

  it("strips every attribute (styles, event handlers) from allowed tags", () => {
    expect(
      sanitizeOutboundHtml('<p class="x" style="color:red" onclick="y()">hi</p>'),
    ).toBe("<p>hi</p>");
    expect(sanitizeOutboundHtml('<strong onmouseover="x">b</strong>')).toBe(
      "<strong>b</strong>",
    );
  });

  it("rejects dangerous href schemes, keeping the anchor without href", () => {
    expect(
      sanitizeOutboundHtml('<a href="javascript:alert(1)">x</a>'),
    ).toBe("<a>x</a>");
    expect(sanitizeOutboundHtml('<a href="data:text/html,<b>">x</a>')).toBe(
      "<a>x</a>",
    );
    // Schemeless / relative hrefs are rejected too (links must be absolute).
    expect(sanitizeOutboundHtml('<a href="/local/path">x</a>')).toBe(
      "<a>x</a>",
    );
  });

  it("sees through entity-encoded and whitespace-obfuscated schemes", () => {
    expect(
      sanitizeOutboundHtml('<a href="java&#115;cript:alert(1)">x</a>'),
    ).toBe("<a>x</a>");
    expect(
      sanitizeOutboundHtml('<a href="javascript&colon;alert(1)">x</a>'),
    ).toBe("<a>x</a>");
    expect(
      sanitizeOutboundHtml('<a href="  javascript:alert(1)">x</a>'),
    ).toBe("<a>x</a>");
  });

  it("escapes stray markup in text while preserving valid entities", () => {
    expect(sanitizeOutboundHtml("a & b")).toBe("a &amp; b");
    expect(sanitizeOutboundHtml("<p>5 &lt; 6 &amp; 7</p>")).toBe(
      "<p>5 &lt; 6 &amp; 7</p>",
    );
    expect(sanitizeOutboundHtml("1 < 2 > 0")).toBe("1 &lt; 2 &gt; 0");
  });

  it("does not throw on malformed input", () => {
    expect(() => sanitizeOutboundHtml("<a href=")).not.toThrow();
    expect(() => sanitizeOutboundHtml("<<<>>>")).not.toThrow();
    expect(() => sanitizeOutboundHtml('<p title="</p>">x')).not.toThrow();
    expect(sanitizeOutboundHtml("")).toBe("");
  });
});

describe("htmlToText — plaintext fallback", () => {
  it("separates paragraphs with a blank line", () => {
    expect(htmlToText("<p>Hello</p><p>World</p>")).toBe("Hello\n\nWorld");
  });

  it("turns <br> into a single newline", () => {
    expect(htmlToText("<p>a<br>b</p>")).toBe("a\nb");
  });

  it("renders bullet lists with '- ' markers", () => {
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe(
      "- one\n- two",
    );
  });

  it("renders numbered lists with incrementing markers", () => {
    expect(htmlToText("<ol><li>one</li><li>two</li><li>three</li></ol>")).toBe(
      "1. one\n2. two\n3. three",
    );
  });

  it("renders headings as their own blocks", () => {
    expect(htmlToText("<h1>Title</h1><p>body</p>")).toBe("Title\n\nbody");
  });

  it("renders links as 'text (href)', collapsing when they match", () => {
    expect(htmlToText('<a href="https://x.io">click</a>')).toBe(
      "click (https://x.io)",
    );
    expect(htmlToText('<a href="https://x.io">https://x.io</a>')).toBe(
      "https://x.io",
    );
  });

  it("decodes entities and strips unknown tags", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &lt;3</p>")).toBe("Tom & Jerry <3");
    expect(htmlToText("<div><span>x</span></div>")).toBe("x");
  });

  it("returns empty string for empty / whitespace-only HTML", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText("<p></p>")).toBe("");
  });
});

describe("plainTextToHtml — editor seeding", () => {
  it("wraps blank-line-separated blocks in paragraphs", () => {
    expect(plainTextToHtml("a\n\nb")).toBe("<p>a</p><p>b</p>");
  });

  it("turns single newlines into <br>", () => {
    expect(plainTextToHtml("a\nb")).toBe("<p>a<br>b</p>");
  });

  it("escapes HTML special characters", () => {
    expect(plainTextToHtml("> quoted <tag> & more")).toBe(
      "<p>&gt; quoted &lt;tag&gt; &amp; more</p>",
    );
  });

  it("returns empty string for empty input", () => {
    expect(plainTextToHtml("")).toBe("");
  });

  it("round-trips through htmlToText for a quoted reply", () => {
    const quoted = "> On Monday, Sam wrote:\n> hello there";
    expect(htmlToText(plainTextToHtml(quoted))).toBe(quoted);
  });
});
