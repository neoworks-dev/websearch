// Each scraped engine against a page saved from it (see scripts/save-fixture.ts). When one of
// these fails after saving a fresh page, the engine's layout changed: fix its selectors.
import { describe, expect, test } from "bun:test";
import {
  bing,
  brave,
  duckduckgo,
  mwmbl,
  searxng,
  startpage,
  tinyfish,
  wikipedia,
  yandex,
  type Engine,
} from "../src/index.ts";

function fixture(name: string): Promise<string> {
  return Bun.file(new URL(`fixtures/${name}.html`, import.meta.url)).text();
}

async function parseFixture(
  engine: Engine,
  name = engine.name,
): Promise<ReturnType<Engine["parse"]>> {
  const { url } = engine.request("deepseek v4.1 flash 1017", { limit: 10, language: "en" });
  return engine.parse({ status: 200, url, body: await fixture(name) });
}

describe.each([
  [bing, 10],
  [brave, 20],
  [startpage, 10],
  [yandex, 14],
] as const)("%o", (engine, count) => {
  test("reads every result, with a real URL and a title, and most with a snippet", async () => {
    const hits = await parseFixture(engine);
    expect(hits).toHaveLength(count);
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https?:\/\//);
      expect(hit.title).not.toBe("");
    }
    // Some results have none on the page itself (Brave shows Reddit threads without one).
    const withSnippet = hits.filter((hit) => hit.snippet !== "").length;
    expect(withSnippet).toBeGreaterThanOrEqual(hits.length * 0.8);
  });

  test("leaves no entities or links back into the engine", async () => {
    const hits = await parseFixture(engine);
    const host = new URL(engine.request("x", { limit: 10, language: "en" }).url).hostname;
    for (const hit of hits) {
      expect(`${hit.title} ${hit.snippet}`).not.toMatch(/&(#\d+|#x[0-9a-f]+|[a-z]+);/i);
      expect(new URL(hit.url).hostname).not.toBe(host);
    }
  });
});

test("bing: the wrapped /ck/a links become their targets", async () => {
  const [first] = await parseFixture(bing);
  expect(first?.url).toBe("https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017");
});

test("duckduckgo: the challenge page is a block, not an empty result", async () => {
  const response = {
    status: 200,
    url: "https://lite.duckduckgo.com/lite/",
    body: await fixture("duckduckgo-blocked"),
  };
  expect(duckduckgo.parse(response)).toEqual([]);
  expect(duckduckgo.blocked?.(response)).toBe(true);
});

test("duckduckgo: results are the rows after each link, redirects unwrapped, ads dropped", () => {
  // The lite page's shape: a link row, then a snippet row, per result.
  const body = `<table>
    <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x" class='result-link'>Example &amp; A</a></td></tr>
    <tr><td class='result-snippet'>The <b>first</b> one.</td></tr>
    <tr><td><a href="https://duckduckgo.com/y.js?ad_provider=x" class='result-link'>An ad</a></td></tr>
    <tr><td class='result-snippet'>Buy now.</td></tr>
    <tr><td><a href="https://example.org/b" class='result-link'>B</a></td></tr>
    <tr><td class='result-snippet'>The second.</td></tr>
  </table>`;
  expect(duckduckgo.parse({ status: 200, url: "https://lite.duckduckgo.com/lite/", body })).toEqual(
    [
      { url: "https://example.com/a", title: "Example & A", snippet: "The first one." },
      { url: "https://example.org/b", title: "B", snippet: "The second." },
    ],
  );
});

describe("the JSON engines", () => {
  test("wikipedia: article URLs from titles, snippets without markup", () => {
    const { url } = wikipedia.request("deepseek", { limit: 10, language: "de" });
    expect(url).toStartWith("https://de.wikipedia.org/w/api.php?");
    const body = JSON.stringify({
      query: {
        search: [
          {
            title: "DeepSeek (AI)",
            snippet: 'A <span class="searchmatch">DeepSeek</span> model &amp; more',
          },
        ],
      },
    });
    expect(wikipedia.parse({ status: 200, url, body })).toEqual([
      {
        url: "https://de.wikipedia.org/wiki/DeepSeek_(AI)",
        title: "DeepSeek (AI)",
        snippet: "A DeepSeek model & more",
      },
    ]);
  });

  test("wikipedia: a language that isn't a code can't change the host", () => {
    const { url } = wikipedia.request("x", { limit: 10, language: "evil.com/" });
    expect(new URL(url).hostname).toBe("en.wikipedia.org");
  });

  test("mwmbl: titles and extracts are joined from their runs", () => {
    const body = JSON.stringify([
      {
        url: "https://example.com",
        title: [
          { value: "Deep", is_bold: true },
          { value: "Seek", is_bold: false },
        ],
        extract: [{ value: "About it", is_bold: false }],
      },
    ]);
    expect(mwmbl.parse({ status: 200, url: "https://api.mwmbl.org/", body })).toEqual([
      { url: "https://example.com", title: "DeepSeek", snippet: "About it" },
    ]);
  });

  test("searxng: the instance's JSON results", () => {
    const engine = searxng("http://127.0.0.1:8888/");
    const { url } = engine.request("q", { limit: 10, language: "en" });
    expect(url).toBe("http://127.0.0.1:8888/search?q=q&format=json&language=en");
    const body = JSON.stringify({
      results: [{ url: "https://a.example", title: "A", content: "a" }],
    });
    expect(engine.parse({ status: 200, url, body })).toEqual([
      { url: "https://a.example", title: "A", snippet: "a" },
    ]);
  });

  test("tinyfish: the key goes in a header, not the URL", () => {
    const request = tinyfish("secret-key").request("q", { limit: 10, language: "en" });
    expect(request.url).not.toContain("secret-key");
    expect(new Headers(request.init?.headers).get("x-api-key")).toBe("secret-key");
  });
});
