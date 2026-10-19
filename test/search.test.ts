import { describe, expect, test } from "bun:test";
import {
  Cooldown,
  mergeHits,
  normalizeUrl,
  search,
  type Engine,
  type Fetch,
  type Hit,
} from "../src/index.ts";
import { rejection } from "./support.ts";

/** An engine whose "page" is the hits as JSON, served by `fakeFetch`. */
function engine(name: string, weight = 1): Engine {
  return {
    name,
    weight,
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
    return new Promise((_resolve, reject) => {
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
