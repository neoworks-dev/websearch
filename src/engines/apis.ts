// The engines with a JSON API: Wikipedia and Mwmbl without a key, SearXNG and TinyFish when the
// caller has an instance or a key.
import { plainText } from "../entities.ts";
import type { Engine, Hit } from "../types.ts";
import { languageCode } from "./html.ts";

const q = encodeURIComponent;

/** Wikipedia asks API clients to name themselves; there is no contact in it on purpose. */
const API_USER_AGENT = "neoworks-websearch/0.1";

// Readers for JSON of unknown shape: a field that isn't what it should be reads as empty.

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") return "";
  return value;
}

function stripTags(html: string): string {
  return plainText(html.replace(/<[^>]*>/g, ""));
}

/** Hits from a JSON array of results, given how to read one. */
function hits(items: unknown[], read: (item: Record<string, unknown>) => Hit): Hit[] {
  return items
    .map((item) => read(record(item)))
    .filter((hit) => hit.url !== "" && hit.title !== "");
}

/** Articles whose text matches; a few at most, since every query matches some article. */
export const wikipedia: Engine = {
  name: "wikipedia",
  weight: 0.5,
  request: (query, options) => ({
    url:
      `https://${languageCode(options.language)}.wikipedia.org/w/api.php?action=query` +
      `&list=search&format=json&srprop=snippet&srlimit=${Math.min(options.limit, 3)}` +
      `&srsearch=${q(query)}`,
    init: { headers: { accept: "application/json", "user-agent": API_USER_AGENT } },
  }),
  parse(response) {
    const origin = new URL(response.url).origin;
    const results = list(record(record(JSON.parse(response.body)).query).search);
    return hits(results, (item) => ({
      url: `${origin}/wiki/${q(text(item.title).replaceAll(" ", "_"))}`,
      title: text(item.title),
      snippet: stripTags(text(item.snippet)),
    }));
  },
};

/** Mwmbl, a small open index run by volunteers (https://mwmbl.org). */
export const mwmbl: Engine = {
  name: "mwmbl",
  weight: 0.5,
  request: (query) => ({
    url: `https://api.mwmbl.org/api/v1/search/?s=${q(query)}`,
    init: { headers: { accept: "application/json", "user-agent": API_USER_AGENT } },
  }),
  parse(response) {
    // Titles and extracts come as runs: [{ value: "DeepSeek", is_bold: true }, …].
    const runs = (value: unknown): string =>
      plainText(
        list(value)
          .map((run) => text(record(run).value))
          .join(""),
      );
    return hits(list(JSON.parse(response.body)), (item) => ({
      url: text(item.url),
      title: runs(item.title),
      snippet: runs(item.extract),
    }));
  },
};

/** A SearXNG instance with the JSON format enabled (`search.formats: [html, json]`). */
export function searxng(baseUrl: string, options: { name?: string; weight?: number } = {}): Engine {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    name: options.name ?? "searxng",
    weight: options.weight ?? 1.5,
    request: (query, requestOptions) => ({
      url: `${base}/search?q=${q(query)}&format=json&language=${languageCode(requestOptions.language)}`,
      init: { headers: { accept: "application/json" } },
    }),
    parse: (response) =>
      hits(list(record(JSON.parse(response.body)).results), (item) => ({
        url: text(item.url),
        title: plainText(text(item.title)),
        snippet: plainText(text(item.content)),
      })),
    blocked: (response) => response.status === 403 || response.status === 429,
  };
}

/** TinyFish's Search API (https://docs.tinyfish.ai/search-api): free up to 12,000 a day. */
export function tinyfish(apiKey: string, options: { weight?: number } = {}): Engine {
  return {
    name: "tinyfish",
    weight: options.weight ?? 1,
    request: (query, requestOptions) => ({
      url: `https://api.search.tinyfish.ai?query=${q(query)}&language=${languageCode(requestOptions.language)}`,
      init: { headers: { accept: "application/json", "x-api-key": apiKey } },
    }),
    parse: (response) =>
      hits(list(record(JSON.parse(response.body)).results), (item) => ({
        url: text(item.url),
        title: plainText(text(item.title)),
        snippet: plainText(text(item.snippet)),
      })),
  };
}
