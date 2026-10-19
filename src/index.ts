// @neoworks/websearch: web search across several engines, and web pages as markdown.
// See the README for usage and for how the engines are kept working.

// Searching
export {
  Cooldown,
  defaultEngines,
  queryEngine,
  search,
  type EngineReport,
  type EngineStatus,
  type SearchOptions,
  type SearchResponse,
} from "./search.ts";
export { mergeHits, normalizeUrl, type Result } from "./merge.ts";
export type { Engine, EngineRequest, EngineResponse, Hit, RequestOptions } from "./types.ts";

// The engines, for building a list of your own
export { bing, brave, duckduckgo, startpage, yandex } from "./engines/scraped.ts";
export { mwmbl, searxng, tinyfish, wikipedia } from "./engines/apis.ts";
export { htmlEngine, type HtmlEngineSpec } from "./engines/html.ts";
export { extractHits, type RawHit, type ResultSelectors } from "./extract.ts";

// Fetching
export { fetchPage, FetchPageError, type FetchPageOptions, type Page } from "./page.ts";
export { htmlToMarkdown, type Markdown } from "./markdown.ts";
export { assertPublicUrl, isPublicAddress, PrivateAddressError } from "./guard.ts";

export { DEFAULT_USER_AGENT, type Fetch } from "./http.ts";
