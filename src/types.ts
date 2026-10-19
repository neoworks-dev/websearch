/** One result as an engine lists it. */
export interface Hit {
  url: string;
  title: string;
  snippet: string;
}

/** What an engine's request is built from. */
export interface RequestOptions {
  /** How many results the caller wants; engines that take a count are asked for this many. */
  limit: number;
  /** A language code such as "en" or "de"; engines that take a language get it. */
  language: string;
}

/** What `fetch` returns, as an engine sees it. */
export interface EngineRequest {
  url: string;
  init?: RequestInit;
}

export interface EngineResponse {
  status: number;
  /** After redirects. */
  url: string;
  body: string;
}

/**
 * A search engine: how to ask it and how to read its answer. Fetching, timeouts and telling a
 * block from an empty page are the caller's (see `search`), so an engine is only a table and two
 * small functions, and its parser can be tested against a saved page.
 */
export interface Engine {
  name: string;
  /** How much a result from this engine counts when results are merged; 1 is a full engine. */
  weight: number;
  request(query: string, options: RequestOptions): EngineRequest;
  parse(response: EngineResponse): Hit[];
  /**
   * Whether a response that gave no results is the engine refusing us (a captcha, a challenge
   * page) rather than having nothing. Asked only when `parse` found nothing.
   */
  blocked?(response: EngineResponse): boolean;
}
