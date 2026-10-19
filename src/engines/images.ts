// The image engines: Bing's image results and DuckDuckGo's image endpoint. A result is an image
// and the page it is on; two results are the same image when their image URLs match.
import { absoluteUrl } from "../extract.ts";
import { plainText } from "../entities.ts";
import type { Engine, ImageHit, ImageSize, SafeSearch } from "../types.ts";
import { DUCKDUCKGO_JSON_BLOCK, duckduckgoRegion, duckduckgoToken } from "./duckduckgo-token.ts";
import { mappedHtmlEngine } from "./html.ts";
import { withParams } from "./url.ts";
import { list, number, parseJson, record, text } from "./json.ts";

const BING_SAFE_SEARCH: Record<SafeSearch, string> = {
  strict: "strict",
  moderate: "moderate",
  off: "off",
};

/** "3840×2160" (or with an x) as numbers. */
function dimensions(text: string): { width: number; height: number } | undefined {
  const match = /(\d+)\s*[×x]\s*(\d+)/.exec(text);
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export const bingImages = mappedHtmlEngine<ImageHit>({
  name: "bing-images",
  weight: 1,
  safeSearch: "supported",
  // The fragment Bing's image page loads as one scrolls.
  url: (query, options) =>
    withParams("https://www.bing.com/images/async", {
      q: query,
      async: 1,
      first: 1,
      count: Math.max(options.limit, 35),
      adlt: BING_SAFE_SEARCH[options.safeSearch],
      qft: options.size && `+filterui:imagesize-${options.size}`,
    }),
  selectors: {
    result: "div.iuscp",
    fields: {
      // The tile's details, as JSON: t (title), murl (image), turl (thumbnail), purl (page).
      metadata: { selector: "a.iusc", attribute: "m" },
      dimensions: { selector: ".img_info span.nowrap" },
      source: { selector: ".lnkw a" },
    },
  },
  blockedBy: /captcha|\/challenge\b/i,
  key: (hit) => hit.image,
  toHit(raw, pageUrl) {
    const metadata = record(parseJson(raw.fields.metadata ?? ""));
    // A tile without its JSON (an ad, a "related searches" tile) is dropped.
    if (!text(metadata.purl) || !text(metadata.murl)) return undefined;
    const url = absoluteUrl(text(metadata.purl), pageUrl);
    const image = absoluteUrl(text(metadata.murl), pageUrl);
    if (!url || !image) return undefined;
    // A tile without a title is named after its site.
    const title = plainText(text(metadata.t)) || raw.fields.source || new URL(url).hostname;
    const hit: ImageHit = { url, image, title, snippet: "" };
    const thumbnail = absoluteUrl(text(metadata.turl), pageUrl);
    if (thumbnail) hit.thumbnail = thumbnail;
    const size = dimensions(raw.fields.dimensions ?? "");
    if (size) Object.assign(hit, size);
    if (raw.fields.source) hit.source = raw.fields.source;
    return hit;
  },
});

/** DuckDuckGo's `p` for images: it has no "moderate" between on and off. */
const DUCKDUCKGO_SAFE_SEARCH: Record<SafeSearch, string> = {
  strict: "1",
  moderate: "1",
  off: "-1",
};

const DUCKDUCKGO_SIZE: Record<ImageSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  wallpaper: "Wallpaper",
};

/** DuckDuckGo's image endpoint (Bing's images underneath), with a token read first. */
export const duckduckgoImages: Engine<ImageHit> = {
  name: "duckduckgo-images",
  weight: 1,
  safeSearch: "supported",
  async request(query, options) {
    const vqd = await duckduckgoToken(query, options);
    return {
      url: withParams("https://duckduckgo.com/i.js", {
        l: duckduckgoRegion(options.language),
        o: "json",
        ct: "AT",
        q: query,
        vqd,
        p: DUCKDUCKGO_SAFE_SEARCH[options.safeSearch],
        // Comma-separated filters: time, size, color, type, layout, license.
        f: options.size && `,size:${DUCKDUCKGO_SIZE[options.size]},,,,`,
      }),
      init: { headers: { accept: "application/json", referer: "https://duckduckgo.com/" } },
    };
  },
  parse(response) {
    const hits: ImageHit[] = [];
    for (const item of list(record(parseJson(response.body)).results).map(record)) {
      const url = text(item.url);
      const image = text(item.image);
      if (!url || !image) continue;
      const hit: ImageHit = { url, image, title: plainText(text(item.title)), snippet: "" };
      if (text(item.thumbnail)) hit.thumbnail = text(item.thumbnail);
      const width = number(item.width);
      const height = number(item.height);
      if (width !== undefined && height !== undefined) Object.assign(hit, { width, height });
      // Its `source` names the provider ("Bing"); the site the image is on says more.
      const site = absoluteUrl(url, "https://duckduckgo.com/");
      if (site) hit.source = new URL(site).hostname.replace(/^www\./, "");
      hits.push(hit);
    }
    return hits;
  },
  blocked: (response) => DUCKDUCKGO_JSON_BLOCK.test(response.body),
};
