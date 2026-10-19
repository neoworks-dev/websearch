// Each engine against an answer saved from it (see scripts/save-fixture.ts). When one of these
// fails after saving a fresh answer, the engine's layout changed: fix its selectors.
import { describe, expect, test } from "bun:test";
import {
  bing,
  bingImages,
  bingNews,
  brave,
  duckduckgo,
  duckduckgoImages,
  duckduckgoNews,
  mwmbl,
  publishedFromAge,
  searxng,
  startpage,
  tinyfish,
  wikipedia,
  yandex,
  type Engine,
  type EngineRequest,
  type EngineResponse,
  type Hit,
  type RequestOptions,
} from "../src/index.ts";

function fixture(name: string): Promise<string> {
  return Bun.file(new URL(`fixtures/${name}`, import.meta.url)).text();
}

/** Request options with DuckDuckGo's token page faked, so building a request asks nothing. */
function options(overrides: Partial<RequestOptions> = {}): RequestOptions {
  const tokenPage: EngineResponse = {
    status: 200,
    url: "https://duckduckgo.com/",
    body: 'vqd="4-12345"',
  };
  return {
    limit: 10,
    language: "en",
    safeSearch: "moderate",
    get: () => Promise.resolve(tokenPage),
    ...overrides,
  };
}

function request<T extends Hit>(
  engine: Engine<T>,
  overrides: Partial<RequestOptions> = {},
  query = "deepseek",
): Promise<EngineRequest> {
  return Promise.resolve(engine.request(query, options(overrides)));
}

async function parseFixture<T extends Hit>(engine: Engine<T>, file: string): Promise<T[]> {
  const { url } = await request(engine);
  return engine.parse({ status: 200, url, body: await fixture(file) });
}

describe.each([
  [bing, "bing.html", 10],
  [brave, "brave.html", 20],
  [startpage, "startpage.html", 10],
  [yandex, "yandex.html", 14],
  [bingNews, "bing-news.html", 10],
  [duckduckgoNews, "duckduckgo-news.json", 27],
  [bingImages, "bing-images.html", 35],
  [duckduckgoImages, "duckduckgo-images.json", 94],
] as const)("%o", (engine: Engine<Hit>, file, count) => {
  test("reads every result, with a real URL and a title", async () => {
    const hits = await parseFixture(engine, file);
    expect(hits).toHaveLength(count);
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https?:\/\//);
      expect(hit.title).not.toBe("");
    }
  });

  test("leaves no entities, markup or links back into the engine", async () => {
    const hits = await parseFixture(engine, file);
    const host = new URL((await request(engine)).url).hostname;
    for (const hit of hits) {
      expect(`${hit.title} ${hit.snippet}`).not.toMatch(/&(#\d+|#x[0-9a-f]+|[a-z]+);|<\/?b>/i);
      expect(new URL(hit.url).hostname).not.toBe(host);
    }
  });
});

describe("web", () => {
  test.each([
    [bing, "bing.html"],
    [brave, "brave.html"],
    [startpage, "startpage.html"],
    [yandex, "yandex.html"],
  ] as const)("%o: most results have a snippet", async (engine, file) => {
    // Some have none on the page itself (Brave shows Reddit threads without one).
    const hits = await parseFixture(engine, file);
    expect(hits.filter((hit) => hit.snippet !== "").length).toBeGreaterThanOrEqual(
      hits.length * 0.8,
    );
  });

  test("bing: the wrapped /ck/a links become their targets", async () => {
    const [first] = await parseFixture(bing, "bing.html");
    expect(first?.url).toBe("https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017");
  });

  test("duckduckgo: the challenge page is a block, not an empty result", async () => {
    const response = {
      status: 200,
      url: "https://lite.duckduckgo.com/lite/",
      body: await fixture("duckduckgo-blocked.html"),
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
    expect(
      duckduckgo.parse({ status: 200, url: "https://lite.duckduckgo.com/lite/", body }),
    ).toEqual([
      { url: "https://example.com/a", title: "Example & A", snippet: "The first one." },
      { url: "https://example.org/b", title: "B", snippet: "The second." },
    ]);
  });
});

describe("news", () => {
  test("bing-news: the age next to the source becomes a date", async () => {
    const [first] = await parseFixture(bingNews, "bing-news.html");
    expect(first).toMatchObject({
      url: "https://www.siliconrepublic.com/machines/deepseek-updates-v4-1-flash-model-to-improve-performance",
      source: "Silicon Republic",
    });
    expect(first?.published).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  test("publishedFromAge reads Bing's units", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(publishedFromAge("Engadget 13h", now)).toBe("2026-10-18T23:00:00.000Z");
    expect(publishedFromAge("42m", now)).toBe("2026-10-19T11:18:00.000Z");
    expect(publishedFromAge("Some paper · 4mon", now)).toBe("2026-06-21T12:00:00.000Z");
    expect(publishedFromAge("Some paper", now)).toBeUndefined();
  });

  test("duckduckgo-news: dates from seconds, publications as sources", async () => {
    const [first] = await parseFixture(duckduckgoNews, "duckduckgo-news.json");
    expect(first).toMatchObject({
      title: "Homeland Security bans DeepSeek use in federal civilian agencies",
      published: "2026-10-19T03:59:00.000Z",
      source: "Engadget",
    });
  });

  test("the time window goes to each engine as its own parameter", async () => {
    expect((await request(bingNews, { since: "week" })).url).toContain(
      `qft=${encodeURIComponent('interval="8"')}`,
    );
    expect((await request(duckduckgoNews, { since: "month" })).url).toContain("df=m");
    expect((await request(bingNews)).url).not.toContain("qft=");
  });
});

describe("images", () => {
  test("bing-images: the tile's JSON gives the image, the page and the thumbnail", async () => {
    const [first] = await parseFixture(bingImages, "bing-images.html");
    expect(first).toEqual({
      url: "https://1000logos.net/deepseek-logo/",
      image: "https://1000logos.net/wp-content/uploads/2025/01/DeepSeek-Logo.jpg",
      title: "DeepSeek Logo and symbol, meaning, history, PNG, brand",
      snippet: "",
      thumbnail: "https://ts3.mm.bing.net/th?id=OIP.TsIsJopSZdPBP3-t3WrHqwHaEK&pid=15.1",
      width: 3840,
      height: 2160,
      source: "1000logos.net",
    });
  });

  test("duckduckgo-images: the source is the image's site, not the provider", async () => {
    const [first] = await parseFixture(duckduckgoImages, "duckduckgo-images.json");
    expect(first).toMatchObject({ width: 3840, height: 2160, source: "1000logos.net" });
  });

  test("the size goes to each engine as its own parameter", async () => {
    expect(decodeURIComponent((await request(bingImages, { size: "large" })).url)).toContain(
      "filterui:imagesize-large",
    );
    expect(decodeURIComponent((await request(duckduckgoImages, { size: "large" })).url)).toContain(
      "size:Large",
    );
  });

  test("duckduckgo: a challenge instead of JSON is a block", () => {
    const body = '{"challenge":{"cc":"sre"},"response_type":"botnet_challenge"}';
    const response = { status: 200, url: "https://duckduckgo.com/i.js", body };
    expect(duckduckgoImages.parse(response)).toEqual([]);
    expect(duckduckgoImages.blocked?.(response)).toBe(true);
  });
});

describe("safe search", () => {
  // Each engine's own words for strict, moderate and off, checked against live results.
  test.each([
    [bing, "adlt=strict", "adlt=moderate", "adlt=off"],
    [duckduckgo, "kp=1", "kp=-1", "kp=-2"],
    [startpage, "qadf=heavy", "qadf=moderate", "qadf=none"],
    [bingNews, "adlt=strict", "adlt=moderate", "adlt=off"],
    [duckduckgoNews, "p=1", "p=-1", "p=-2"],
    [bingImages, "adlt=strict", "adlt=moderate", "adlt=off"],
    // DuckDuckGo's images have no moderate: it is the same as strict.
    [duckduckgoImages, "p=1", "p=1", "p=-1"],
    [searxng("http://127.0.0.1:8888"), "safesearch=2", "safesearch=1", "safesearch=0"],
  ] as const)("%o", async (engine: Engine<Hit>, strict, moderate, off) => {
    expect((await request(engine, { safeSearch: "strict" })).url).toContain(strict);
    expect((await request(engine, { safeSearch: "moderate" })).url).toContain(moderate);
    expect((await request(engine, { safeSearch: "off" })).url).toContain(off);
  });

  test("brave: in a cookie", async () => {
    const { init } = await request(brave, { safeSearch: "strict" });
    expect(new Headers(init?.headers).get("cookie")).toBe("safesearch=strict");
  });

  test("engines without the setting say so", () => {
    expect([yandex, mwmbl, tinyfish("key")].map((engine) => engine.safeSearch)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
    ]);
    expect(wikipedia.safeSearch).toBe("not-needed");
  });
});

describe("the JSON web engines", () => {
  test("wikipedia: article URLs from titles, snippets without markup", async () => {
    const { url } = await request(wikipedia, { language: "de" });
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

  test("wikipedia: a language that isn't a code can't change the host", async () => {
    const { url } = await request(wikipedia, { language: "evil.com/" });
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

  test("searxng: the instance's JSON results", async () => {
    const engine = searxng("http://127.0.0.1:8888/");
    const { url } = await request(engine, {}, "q");
    expect(url).toBe("http://127.0.0.1:8888/search?q=q&format=json&language=en&safesearch=1");
    const body = JSON.stringify({
      results: [{ url: "https://a.example", title: "A", content: "a" }],
    });
    expect(engine.parse({ status: 200, url, body })).toEqual([
      { url: "https://a.example", title: "A", snippet: "a" },
    ]);
  });

  test("tinyfish: the key goes in a header, not the URL", async () => {
    const { url, init } = await request(tinyfish("secret-key"));
    expect(url).not.toContain("secret-key");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("secret-key");
  });
});
