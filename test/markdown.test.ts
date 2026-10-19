import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "../src/index.ts";

const URL = "https://example.com/docs/page";

function md(body: string, head = ""): string {
  return htmlToMarkdown(`<html><head>${head}</head><body>${body}</body></html>`, URL).markdown;
}

describe("htmlToMarkdown", () => {
  test("headings, paragraphs and inline code", () => {
    expect(md("<h1>Title</h1><p>Some <code>code</code>\n   here.</p><h3>Sub</h3><p>More</p>")).toBe(
      "# Title\n\nSome `code` here.\n\n### Sub\n\nMore",
    );
  });

  test("links resolve against the page, or its <base>; fragments are text", () => {
    expect(md('<p><a href="../api">API</a> and <a href="#x">here</a></p>')).toBe(
      "[API](https://example.com/api) and here",
    );
    expect(md('<p><a href="b">B</a></p>', '<base href="https://cdn.example/x/">')).toBe(
      "[B](https://cdn.example/x/b)",
    );
  });

  test("nested lists keep their numbers and indentation", () => {
    expect(md("<ol start=3><li>three<ul><li>a</li><li>b</li></ul></li><li>four</li></ol>")).toBe(
      "3. three\n  - a\n  - b\n4. four",
    );
  });

  test("code blocks keep their whitespace and take the language from the class", () => {
    expect(
      md('<pre class="language-ts">const a = 1;\n\n  if (a &lt; 2) {}\n</pre><p>after</p>'),
    ).toBe("```ts\nconst a = 1;\n\n  if (a < 2) {}\n\n```\n\nafter");
  });

  test("tables with a header row; one-column tables are paragraphs", () => {
    expect(
      md(
        "<table><tr><th>Name</th><th>Price</th></tr><tr><td>Flash</td><td>$0.30 | 1M</td></tr></table>",
      ),
    ).toBe("| Name | Price |\n| --- | --- |\n| Flash | $0.30 \\| 1M |");
    expect(md("<table><tr><td>layout</td></tr><tr><td>only</td></tr></table>")).toBe(
      "layout\n\nonly",
    );
  });

  test("quotes are prefixed line by line", () => {
    expect(md("<blockquote><p>one</p><p>two</p></blockquote>")).toBe("> one\n>\n> two");
  });

  test("scripts, navigation, footers and hidden parts are dropped", () => {
    expect(
      md(
        "<nav><a href='/'>Home</a></nav><script>var x = 1</script><style>p{}</style>" +
          "<p>Kept</p><div hidden>secret</div><span aria-hidden='true'>icon</span>" +
          "<footer>© 2026</footer><button>Click</button>",
      ),
    ).toBe("Kept");
  });

  test("<main> is used when it holds the content, the rest left out", () => {
    const page = `<header><a href="/">Site</a> menu menu menu</header>
      <main><h1>Article</h1><p>${"The content. ".repeat(20)}</p></main>
      <div class="related">Related links and more links</div>`;
    const markdown = md(page);
    expect(markdown).toStartWith("# Article");
    expect(markdown).not.toContain("Related");
  });

  test("a tiny <main> (a shell filled by scripts) doesn't hide the page", () => {
    const markdown = md(`<main>Loading</main><div><p>${"Real text. ".repeat(30)}</p></div>`);
    expect(markdown).toContain("Real text.");
  });

  test("the title, the description and entities", () => {
    const page = htmlToMarkdown(
      '<html><head><title>A &amp; B</title><meta name="description" content="About &quot;it&quot;"></head>' +
        "<body><p>caf&eacute; &#8212; &#x2713; &nbsp;done</p></body></html>",
      URL,
    );
    expect(page).toEqual({ title: "A & B", description: 'About "it"', markdown: "café — ✓ done" });
  });
});
