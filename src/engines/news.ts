// The news engines: Bing's news page and DuckDuckGo's news endpoint. Both give a publication
// date; Bing writes it as an age ("5h", "4mon"), which is turned into a date here.
import { absoluteUrl } from "../extract.ts";
import type { Engine, NewsHit, SafeSearch, Since } from "../types.ts";
import { DUCKDUCKGO_JSON_BLOCK, duckduckgoRegion, duckduckgoToken } from "./duckduckgo-token.ts";
import { mappedHtmlEngine } from "./html.ts";
import { withParams } from "./url.ts";
import { list, number, parseJson, record, stripTags, text } from "./json.ts";
import { duckduckgoSafeSearch } from "./web.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Bing's age units: "42m", "5h", "1d", "2w", "4mon", "1y". */
const AGE_UNITS: Record<string, number> = {
  m: MINUTE,
  min: MINUTE,
  h: HOUR,
  d: DAY,
  w: 7 * DAY,
  mon: 30 * DAY,
  y: 365 * DAY,
};

/** The date an age at the end of `text` ("Engadget · 13h") points back to, as ISO. */
export function publishedFromAge(text: string, now = Date.now()): string | undefined {
  const match = /(\d+)\s*(mon|min|m|h|d|w|y)\s*$/.exec(text);
  const unit = match?.[2] === undefined ? undefined : AGE_UNITS[match[2]];
  if (!match || unit === undefined) return undefined;
  return new Date(now - Number(match[1]) * unit).toISOString();
}

/** Bing news' `interval` filter; values measured against its results. */
const BING_INTERVAL: Record<Since, string> = { hour: "4", day: "7", week: "8", month: "9" };

const BING_SAFE_SEARCH: Record<SafeSearch, string> = {
  strict: "strict",
  moderate: "moderate",
  off: "off",
};

export const bingNews = mappedHtmlEngine<NewsHit>({
  name: "bing-news",
  weight: 1,
  safeSearch: "supported",
  // The fragment Bing's news page loads as one scrolls: the results without the page around them.
  url: (query, options) =>
    withParams("https://www.bing.com/news/infinitescrollajax", {
      q: query,
      InfiniteScroll: 1,
      first: 1,
      SFX: 1,
      adlt: BING_SAFE_SEARCH[options.safeSearch],
      qft: options.since && `interval="${BING_INTERVAL[options.since]}"`,
    }),
  selectors: {
    result: "div.newsitem",
    link: { selector: "div.newsitem", attribute: "url" },
    title: { selector: "div.newsitem", attribute: "data-title" },
    snippet: ".snippet",
    fields: {
      source: { selector: "div.newsitem", attribute: "data-author" },
      // The source's name and the age: "Silicon Republic · 5h".
      byline: { selector: ".source" },
      image: { selector: "a.imagelink img", attribute: "src" },
    },
  },
  blockedBy: /captcha|\/challenge\b/i,
  toHit(raw, pageUrl) {
    const url = absoluteUrl(raw.href, pageUrl);
    if (!url || !raw.title) return undefined;
    const hit: NewsHit = { url, title: raw.title, snippet: raw.snippet };
    const published = publishedFromAge(raw.fields.byline ?? "");
    if (published) hit.published = published;
    if (raw.fields.source) hit.source = raw.fields.source;
    const image = raw.fields.image ? absoluteUrl(raw.fields.image, pageUrl) : undefined;
    if (image) hit.image = image;
    return hit;
  },
});

const DUCKDUCKGO_SINCE: Record<Since, string> = { hour: "d", day: "d", week: "w", month: "m" };

/** DuckDuckGo's news endpoint (Bing's news underneath), with a token read first. */
export const duckduckgoNews: Engine<NewsHit> = {
  name: "duckduckgo-news",
  weight: 1,
  safeSearch: "supported",
  async request(query, options) {
    const vqd = await duckduckgoToken(query, options);
    return {
      url: withParams("https://duckduckgo.com/news.js", {
        l: duckduckgoRegion(options.language),
        o: "json",
        noamp: 1,
        q: query,
        vqd,
        p: duckduckgoSafeSearch(options.safeSearch),
        df: options.since && DUCKDUCKGO_SINCE[options.since],
      }),
      init: { headers: { accept: "application/json", referer: "https://duckduckgo.com/" } },
    };
  },
  parse(response) {
    const hits: NewsHit[] = [];
    for (const item of list(record(parseJson(response.body)).results).map(record)) {
      const url = text(item.url);
      // Titles and excerpts can carry the query's words in <b>.
      const title = stripTags(text(item.title));
      if (!url || !title) continue;
      const hit: NewsHit = { url, title, snippet: stripTags(text(item.excerpt)) };
      // `date` is in seconds since 1970.
      const seconds = number(item.date);
      if (seconds !== undefined) hit.published = new Date(seconds * 1000).toISOString();
      if (text(item.source)) hit.source = text(item.source);
      if (text(item.image)) hit.image = text(item.image);
      hits.push(hit);
    }
    return hits;
  },
  blocked: (response) => DUCKDUCKGO_JSON_BLOCK.test(response.body),
};
