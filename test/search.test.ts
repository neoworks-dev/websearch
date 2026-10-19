import { describe, expect, test } from "bun:test";
import {
  Cooldown,
  EngineBlockedError,
  searchImages,
  type ImageHit,
  type NewsHit,
  mergeHits,
  normalizeUrl,
  search,
  type Engine,
  type Fetch,
  type Hit,
} from "../src/index.ts";
import { rejection } from "./support.ts";

/** An engine whose "page" is the hits as JSON, served by `fakeFetch`. */
function engine(name: string, weight = 1, safeSearch: Engine["safeSearch"] = "supported"): Engine {
  return {
    name,
    weight,
    safeSearch,
    request: (query) => ({ url: `https://${name}.example/?q=${encodeURIComponent(query)}` }),
    parse: (response) => parseHits(response.body),
    blocked: (response) => response.body.includes("captcha"),
  };
}

function parseHits(body: string): Hit[] {
  const hits: Hit[] = JSON.parse(body);
  return hits;
}

function hit(url: string, title = url, snippet = ""): Hit {
  return { url, title, snippet };
}

/** What the fake engine answers: hits, a status, a page, or nothing ever. */
type Answer = Hit[] | number | { page: string } | { hang: true };

function fakeFetch(answers: Record<string, Answer>): Fetch {
  return (url, init) => {
    const answer = answers[new URL(url).hostname.split(".")[0] ?? ""] ?? [];
    if (typeof answer === "number") return Promise.resolve(new Response("", { status: answer }));
    if (Array.isArray(answer)) return Promise.resolve(new Response(JSON.stringify(answer)));
    if ("page" in answer) return Promise.resolve(new Response(answer.page));
    // Like a real fetch: an aborted signal rejects, at once if it already is.
    return new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  };
}

describe("normalizeUrl", () => {
  test("the same page under small differences is one key", () => {
    const key = normalizeUrl("https://example.com/a");
    for (const url of [
      "http://example.com/a",
      "https://www.example.com/a/",
      "https://example.com/a#section",
      "https://example.com/a?utm_source=x&fbclid=y",
    ]) {
      expect(normalizeUrl(url)).toBe(key);
    }
    expect(normalizeUrl("https://example.com/a?page=2")).not.toBe(key);
  });
});

describe("mergeHits", () => {
  test("found by more engines and higher up ranks first", () => {
    const merged = mergeHits(
      [
        { engine: engine("a"), hits: [hit("https://one.example"), hit("https://two.example")] },
        { engine: engine("b"), hits: [hit("https://two.example/"), hit("https://three.example")] },
      ],
      10,
    );
    expect(merged.map((result) => [result.url, result.engines, result.score])).toEqual([
      ["https://two.example", ["b", "a"], 1.5],
      ["https://one.example", ["a"], 1],
      ["https://three.example", ["b"], 0.5],
    ]);
  });

  test("keeps the longest snippet and prefers https", () => {
    const [merged] = mergeHits(
      [
        { engine: engine("a"), hits: [hit("http://x.example", "X", "short")] },
        { engine: engine("b"), hits: [hit("https://x.example", "X again", "a longer snippet")] },
      ],
      10,
    );
    expect(merged).toMatchObject({
      url: "https://x.example",
      title: "X",
      snippet: "a longer snippet",
    });
  });
});

describe("search", () => {
  test("asks every engine and says how each one did", async () => {
    const response = await search("deepseek", {
      engines: [
        engine("good"),
        engine("blocked"),
        engine("captcha"),
        engine("empty"),
        engine("broken"),
      ],
      fetch: fakeFetch({
        good: [hit("https://a.example")],
        blocked: 429,
        captcha: { page: "<html>solve this captcha</html>" },
        empty: [],
        broken: 500,
      }),
      cooldown: false,
    });
    expect(response.results.map((result) => result.url)).toEqual(["https://a.example"]);
    expect(response.engines.map(({ engine, status }) => [engine, status])).toEqual([
      ["good", "ok"],
      ["blocked", "blocked"],
      ["captcha", "blocked"],
      ["empty", "empty"],
      ["broken", "error"],
    ]);
  });

  test("an engine that doesn't answer in time is a timeout, and the rest still count", async () => {
    const response = await search("q", {
      engines: [engine("slow"), engine("fast")],
      fetch: fakeFetch({ slow: { hang: true }, fast: [hit("https://a.example")] }),
      timeoutMs: 20,
      cooldown: false,
    });
    expect(response.engines.map((report) => report.status)).toEqual(["timeout", "ok"]);
    expect(response.results).toHaveLength(1);
  });

  test("a blocked engine sits out until its cooldown ends", async () => {
    let now = 0;
    const cooldown = new Cooldown(1000, 10_000, () => now);
    const options = { engines: [engine("e")], cooldown };
    await search("q", { ...options, fetch: fakeFetch({ e: 429 }) });
    const cooling = await search("q", {
      ...options,
      fetch: fakeFetch({ e: [hit("https://a.example")] }),
    });
    expect(cooling.engines[0]?.status).toBe("cooling");
    now = 1001;
    const back = await search("q", {
      ...options,
      fetch: fakeFetch({ e: [hit("https://a.example")] }),
    });
    expect(back.engines[0]?.status).toBe("ok");
  });

  test("each block doubles the wait, up to the maximum", () => {
    let now = 0;
    const cooldown = new Cooldown(1000, 3000, () => now);
    const coolingAt = (time: number): boolean => {
      now = time;
      return cooldown.cooling("e");
    };
    cooldown.blocked("e"); // until 1000
    expect(coolingAt(999)).toBe(true);
    expect(coolingAt(1000)).toBe(false);
    cooldown.blocked("e"); // 2000 more
    expect(coolingAt(2999)).toBe(true);
    cooldown.blocked("e"); // 4000, capped at 3000: until 5999
    expect(coolingAt(5998)).toBe(true);
    expect(coolingAt(5999)).toBe(false);
  });

  test("the caller's abort rejects the search", async () => {
    const controller = new AbortController();
    const pending = search("q", {
      engines: [engine("slow")],
      fetch: fakeFetch({ slow: { hang: true } }),
      signal: controller.signal,
      cooldown: false,
    });
    controller.abort();
    await rejection(pending);
  });

  test("an empty query is refused", async () => {
    expect((await rejection(search("  "))).message).toContain("empty");
  });
});

describe("safe search", () => {
  test("strict leaves out engines that can't filter, and says why", async () => {
    const response = await search("q", {
      engines: [
        engine("filters"),
        engine("no-filter", 1, "unsupported"),
        engine("wiki", 1, "not-needed"),
      ],
      fetch: fakeFetch({ filters: [hit("https://a.example")], wiki: [hit("https://w.example")] }),
      safeSearch: "strict",
      cooldown: false,
    });
    expect(response.engines.map(({ engine, status, detail }) => [engine, status, detail])).toEqual([
      ["filters", "ok", undefined],
      ["no-filter", "skipped", "has no safe search"],
      ["wiki", "ok", undefined],
    ]);
  });

  test("moderate and off ask every engine", async () => {
    const response = await search("q", {
      engines: [engine("no-filter", 1, "unsupported")],
      fetch: fakeFetch({ "no-filter": [hit("https://a.example")] }),
      safeSearch: "off",
      cooldown: false,
    });
    expect(response.engines[0]?.status).toBe("ok");
  });
});

describe("engines that read a page first", () => {
  /** Asks for a token page, then the results, both through the search's fetch. */
  const tokenEngine: Engine = {
    name: "token",
    weight: 1,
    safeSearch: "supported",
    async request(query, options) {
      const page = await options.get("https://token.example/");
      if (page.body.includes("challenge")) throw new EngineBlockedError("token page blocked");
      return { url: `https://results.example/?q=${query}&token=${page.body}` };
    },
    parse: (response) => parseHits(response.body),
  };

  test("the page comes through the same fetch, and the token reaches the request", async () => {
    const asked: string[] = [];
    const fetch: Fetch = (url) => {
      asked.push(url);
      const body = url.startsWith("https://token")
        ? "t1"
        : JSON.stringify([hit("https://a.example")]);
      return Promise.resolve(new Response(body));
    };
    const response = await search("q", { engines: [tokenEngine], fetch, cooldown: false });
    expect(asked).toEqual(["https://token.example/", "https://results.example/?q=q&token=t1"]);
    expect(response.results).toHaveLength(1);
  });

  test("a blocked page before the request makes the engine blocked", async () => {
    const fetch: Fetch = () => Promise.resolve(new Response("a challenge"));
    const response = await search("q", { engines: [tokenEngine], fetch, cooldown: false });
    expect(response.engines[0]).toMatchObject({ status: "blocked", detail: "token page blocked" });
  });
});

describe("merging news and images", () => {
  test("a value the first engine lacked comes from the next one", () => {
    const dated: NewsHit = {
      ...hit("https://news.example/1", "Story, again"),
      published: "2026-10-19",
    };
    const [merged] = mergeHits(
      [
        { engine: engine("a"), hits: [hit("https://news.example/1", "Story")] },
        { engine: engine("b"), hits: [dated] },
      ],
      10,
    );
    expect(merged).toMatchObject({ title: "Story", published: "2026-10-19", engines: ["a", "b"] });
  });

  test("searchImages: the same image on two pages is one result", async () => {
    const onPage = (page: string): ImageHit => ({
      url: page,
      title: page,
      snippet: "",
      image: "https://cdn.example/logo.png",
    });
    const imageEngine = (name: string, page: string): Engine<ImageHit> => ({
      name,
      weight: 1,
      safeSearch: "supported",
      request: () => ({ url: `https://${name}.example/` }),
      parse: () => [onPage(page)],
    });
    const response = await searchImages("logo", {
      engines: [imageEngine("a", "https://one.example"), imageEngine("b", "https://two.example")],
      fetch: () => Promise.resolve(new Response("")),
      cooldown: false,
    });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.engines).toEqual(["a", "b"]);
  });
});
