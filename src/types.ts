/** One result as an engine lists it. */
export interface Hit {
  url: string;
  title: string;
  snippet: string;
}

/** A news article. */
export interface NewsHit extends Hit {
  /** When it was published, as an ISO date; engines that give "5h ago" are converted. */
  published?: string;
  /** The publication: "Engadget", "Silicon Republic". */
  source?: string;
  image?: string;
}

/** An image; `url` is the page it is on, `image` the image itself. */
export interface ImageHit extends Hit {
  image: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  /** The site it is on: "1000logos.net". */
  source?: string;
}

/**
 * How much adult content may come back, passed to each engine as its own setting:
 * "strict" filters it out, "moderate" filters explicit images and video (each engine's
 * default), "off" filters nothing.
 */
export type SafeSearch = "strict" | "moderate" | "off";

/** A time window for news: published within the last hour, day, week or month. */
export type Since = "hour" | "day" | "week" | "month";

export type ImageSize = "small" | "medium" | "large" | "wallpaper";

/** What an engine's request is built from. */
export interface RequestOptions {
  /** How many results the caller wants; engines that take a count are asked for this many. */
  limit: number;
  /** A language code such as "en" or "de"; engines that take a language get it. */
  language: string;
  safeSearch: SafeSearch;
  /** News engines only. */
  since?: Since;
  /** Image engines only. */
  size?: ImageSize;
  /**
   * Fetches a page with the same headers, timeout and signal as the search, for an engine that
   * has to read one before it can ask (DuckDuckGo hands out a token per query).
   */
  get(url: string): Promise<EngineResponse>;
}

export interface EngineRequest {
  url: string;
  init?: RequestInit;
}

/** What `fetch` returned, as an engine sees it. */
export interface EngineResponse {
  status: number;
  /** After redirects. */
  url: string;
  body: string;
}

/**
 * A search engine: how to ask it and how to read its answer. Fetching, timeouts and telling a
 * block from an empty page are the caller's (see `search`), so an engine is little more than a
 * table and two small functions, and its parser can be tested against a saved page.
 */
export interface Engine<T extends Hit = Hit> {
  /** Unique across all engines: it keys the cooldown. */
  name: string;
  /** How much a result from this engine counts when results are merged; 1 is a full engine. */
  weight: number;
  /**
   * - "supported": the engine is passed the `safeSearch` setting;
   * - "unsupported": it has no such setting, so "strict" leaves it out;
   * - "not-needed": its results aren't adult content to begin with (Wikipedia).
   */
  safeSearch: "supported" | "unsupported" | "not-needed";
  request(query: string, options: RequestOptions): EngineRequest | Promise<EngineRequest>;
  parse(response: EngineResponse): T[];
  /**
   * Whether a response that gave no results is the engine refusing us (a captcha, a challenge
   * page) rather than having nothing. Asked only when `parse` found nothing or threw.
   */
  blocked?(response: EngineResponse): boolean;
}

/**
 * Thrown by an engine's `request` when the page it had to read first was a block page. The
 * engine is then reported as blocked rather than as failing.
 */
export class EngineBlockedError extends Error {
  override name = "EngineBlockedError";
}
