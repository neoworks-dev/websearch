// @neoworks/websearch: web, news and image search across several engines, and web pages as
// markdown. See the README for usage and for how the engines are kept working.

// Searching
export {
  Cooldown,
  imageEngines,
  newsEngines,
  queryEngine,
  search,
  searchImages,
  searchNews,
  webEngines,
  type EngineReport,
  type EngineStatus,
  type ImageSearchOptions,
  type NewsSearchOptions,
  type SearchOptions,
  type SearchResponse,
} from "./search.ts";
export { mergeHits, normalizeUrl, type Result } from "./merge.ts";
export {
  EngineBlockedError,
  type Engine,
  type EngineRequest,
  type EngineResponse,
  type Hit,
  type ImageHit,
  type ImageSize,
  type NewsHit,
  type RequestOptions,
  type SafeSearch,
  type Since,
} from "./types.ts";

// The engines, for building a list of your own
export { bing, brave, duckduckgo, startpage, yandex } from "./engines/web.ts";
export { bingNews, duckduckgoNews, publishedFromAge } from "./engines/news.ts";
export { bingImages, duckduckgoImages } from "./engines/images.ts";
export { mwmbl, searxng, tinyfish, wikipedia } from "./engines/apis.ts";
export {
  htmlEngine,
  mappedHtmlEngine,
  type HtmlEngineSpec,
  type MappedHtmlEngineSpec,
} from "./engines/html.ts";
export { extractHits, type Field, type RawHit, type ResultSelectors } from "./extract.ts";

// Fetching
export { fetchPage, type FetchPageOptions, type Page, type PageProblem } from "./page.ts";
export { FetchPageError, type FetchPageErrorCode } from "./errors.ts";
export { blockedBy } from "./blocks.ts";
export { htmlToMarkdown, type Markdown } from "./markdown.ts";
export { assertPublicUrl, isPublicAddress } from "./guard.ts";

export { DEFAULT_USER_AGENT, type Fetch } from "./http.ts";
