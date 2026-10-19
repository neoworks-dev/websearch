// Asks every engine at once, gives each a few seconds, and merges what came back. An engine that
// refuses us is reported as blocked rather than as having found nothing, and sits out a while.
// `search`, `searchNews` and `searchImages` are the same run over different engines.
import { mwmbl, wikipedia } from "./engines/apis.ts";
import { languageCode } from "./engines/html.ts";
import { bingImages, duckduckgoImages } from "./engines/images.ts";
import { bingNews, duckduckgoNews } from "./engines/news.ts";
import { bing, brave, duckduckgo, startpage, yandex } from "./engines/web.ts";
import { DEFAULT_USER_AGENT, type Fetch } from "./http.ts";
import { mergeHits, normalizeUrl, type Result } from "./merge.ts";
import {
  EngineBlockedError,
  type Engine,
  type EngineResponse,
  type Hit,
  type ImageHit,
  type ImageSize,
  type NewsHit,
  type RequestOptions,
  type SafeSearch,
  type Since,
} from "./types.ts";

/** The web engines that need no key. SearXNG and TinyFish need an instance or a key. */
export const webEngines: readonly Engine[] = [
  bing,
  duckduckgo,
  brave,
  startpage,
  yandex,
  wikipedia,
  mwmbl,
];

export const newsEngines: readonly Engine<NewsHit>[] = [bingNews, duckduckgoNews];

export const imageEngines: readonly Engine<ImageHit>[] = [bingImages, duckduckgoImages];

export interface SearchOptions<T extends Hit = Hit> {
  engines?: readonly Engine<T>[];
  /** At most this many results; 10. */
  limit?: number;
  /** "en", "de", …; "en". */
  language?: string;
  /** "moderate", each engine's own default. See `SafeSearch`. */
  safeSearch?: SafeSearch;
  /** How long each engine gets; 6 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: Fetch;
  userAgent?: string;
  /** Where blocked engines are remembered; the shared one, or false to ask every engine anyway. */
  cooldown?: Cooldown | false;
}

export interface NewsSearchOptions extends SearchOptions<NewsHit> {
  /** Only articles published within this window. */
  since?: Since;
}

export interface ImageSearchOptions extends SearchOptions<ImageHit> {
  size?: ImageSize;
}

export type EngineStatus =
  /** Results came back. */
  | "ok"
  /** The page had no results and no sign of a block: nothing found, or the layout changed. */
  | "empty"
  /** A captcha, a challenge page, or a status that means "not you". */
  | "blocked"
  /** No answer within the time it had. */
  | "timeout"
  /** Anything else: a network error, an unexpected status, a parser error. */
  | "error"
  /** Blocked recently, so not asked. */
  | "cooling"
  /** Not asked: it can't do what was asked of it ("strict" safe search). */
  | "skipped";

export interface EngineReport {
  engine: string;
  status: EngineStatus;
  results: number;
  ms: number;
  /** For "error", "blocked" and "skipped": what happened. */
  detail?: string;
}

export interface SearchResponse<T extends Hit = Hit> {
  query: string;
  results: Result<T>[];
  /** One per engine, in the order given. */
  engines: EngineReport[];
}

/** Searches the web with every engine at once and merges the results. */
export function search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  return run(query, options, webEngines, (hit) => normalizeUrl(hit.url));
}

/** Searches news; results carry a `published` date and a `source` where the engine gives one. */
export function searchNews(
  query: string,
  options: NewsSearchOptions = {},
): Promise<SearchResponse<NewsHit>> {
  return run(query, options, newsEngines, (hit) => normalizeUrl(hit.url));
}

/** Searches images; the same image found on several pages is one result. */
export function searchImages(
  query: string,
  options: ImageSearchOptions = {},
): Promise<SearchResponse<ImageHit>> {
  return run(query, options, imageEngines, (hit) => normalizeUrl(hit.image));
}

/** Statuses that mean the engine refuses this client (DuckDuckGo answers a challenge with 202). */
const REFUSING = new Set([202, 401, 403, 429, 503]);

/**
 * Which engines are blocked, until when. Each block doubles the wait (15 minutes, 30, … up to 6
 * hours); a good answer clears it.
 */
export class Cooldown {
  private readonly blocks = new Map<string, { until: number; strikes: number }>();

  constructor(
    private readonly baseMs = 15 * 60_000,
    private readonly maxMs = 6 * 60 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  cooling(engine: string): boolean {
    const block = this.blocks.get(engine);
    return block !== undefined && block.until > this.now();
  }

  blocked(engine: string): void {
    const strikes = (this.blocks.get(engine)?.strikes ?? 0) + 1;
    const wait = Math.min(this.baseMs * 2 ** (strikes - 1), this.maxMs);
    this.blocks.set(engine, { until: this.now() + wait, strikes });
  }

  answered(engine: string): void {
    this.blocks.delete(engine);
  }
}

const sharedCooldown = new Cooldown();

type AnyOptions<T extends Hit> = SearchOptions<T> & { since?: Since; size?: ImageSize };

interface Run<T extends Hit> {
  engine: Engine<T>;
  hits: T[];
  report: EngineReport;
}

async function run<T extends Hit>(
  query: string,
  options: AnyOptions<T>,
  defaults: readonly Engine<T>[],
  key: (hit: T) => string,
): Promise<SearchResponse<T>> {
  const trimmed = query.trim();
  if (trimmed === "") throw new Error("The query is empty");
  const cooldown = options.cooldown === false ? undefined : (options.cooldown ?? sharedCooldown);
  const notAsked = (engine: Engine<T>, status: EngineStatus, detail?: string): Run<T> => {
    const report: EngineReport = { engine: engine.name, status, results: 0, ms: 0 };
    if (detail !== undefined) report.detail = detail;
    return { engine, hits: [], report };
  };
  const runs = await Promise.all(
    (options.engines ?? defaults).map(async (engine): Promise<Run<T>> => {
      if (options.safeSearch === "strict" && engine.safeSearch === "unsupported") {
        return notAsked(engine, "skipped", "has no safe search");
      }
      if (cooldown?.cooling(engine.name)) return notAsked(engine, "cooling");
      const result = await queryEngine(engine, trimmed, options);
      if (result.report.status === "blocked") cooldown?.blocked(engine.name);
      if (result.report.status === "ok") cooldown?.answered(engine.name);
      return { engine, ...result };
    }),
  );
  options.signal?.throwIfAborted();
  return {
    query: trimmed,
    results: mergeHits(runs, options.limit ?? 10, key),
    engines: runs.map((result) => result.report),
  };
}

/**
 * Asks one engine and judges its answer. The searches do this for every engine; the live check
 * calls it directly. Neither the cooldown nor `safeSearch: "strict"` skipping happens here.
 */
export async function queryEngine<T extends Hit>(
  engine: Engine<T>,
  query: string,
  options: AnyOptions<T> = {},
): Promise<{ hits: T[]; report: EngineReport }> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 6000);
  let outcome: Outcome<T>;
  try {
    const answer = await ask(engine, query, options, timeout);
    outcome = judge(engine, answer, options.limit ?? 10);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof EngineBlockedError) {
      outcome = { status: "blocked", hits: [], detail: error.message };
    } else if (timeout.aborted) {
      outcome = { status: "timeout", hits: [] };
    } else {
      outcome = { status: "error", hits: [], detail: messageOf(error) };
    }
  }
  const report: EngineReport = {
    engine: engine.name,
    status: outcome.status,
    results: outcome.hits.length,
    ms: Math.round(performance.now() - started),
  };
  if (outcome.detail !== undefined) report.detail = outcome.detail;
  return { hits: outcome.hits, report };
}

interface Outcome<T> {
  status: EngineStatus;
  hits: T[];
  detail?: string;
}

/** The browser-like defaults, then the request's own headers (an API key, an Accept). */
function headers<T extends Hit>(init: RequestInit | undefined, options: AnyOptions<T>): Headers {
  const language = languageCode(options.language ?? "en");
  const merged = new Headers({
    "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": language === "en" ? "en-US,en;q=0.9" : `${language},en;q=0.8`,
  });
  new Headers(init?.headers).forEach((value, name) => merged.set(name, value));
  return merged;
}

/** Fetches the engine's answer for `query`, and any page its request needs first. */
async function ask<T extends Hit>(
  engine: Engine<T>,
  query: string,
  options: AnyOptions<T>,
  timeout: AbortSignal,
): Promise<EngineResponse> {
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const fetchFrom = async (url: string, init?: RequestInit): Promise<EngineResponse> => {
    const response = await (options.fetch ?? fetch)(url, {
      ...init,
      headers: headers(init, options),
      redirect: "follow",
      signal,
    });
    return { status: response.status, url: response.url || url, body: await response.text() };
  };
  const requestOptions: RequestOptions = {
    limit: options.limit ?? 10,
    language: languageCode(options.language ?? "en"),
    safeSearch: options.safeSearch ?? "moderate",
    get: (url) => fetchFrom(url),
  };
  if (options.since !== undefined) requestOptions.since = options.since;
  if (options.size !== undefined) requestOptions.size = options.size;
  const request = await engine.request(query, requestOptions);
  return fetchFrom(request.url, request.init);
}

/** What an answer means: results, a refusal, nothing, or a failure. */
function judge<T extends Hit>(
  engine: Engine<T>,
  answer: EngineResponse,
  limit: number,
): Outcome<T> {
  const blockPage: Outcome<T> = { status: "blocked", hits: [], detail: "block page" };
  if (REFUSING.has(answer.status)) {
    return { status: "blocked", hits: [], detail: `HTTP ${answer.status}` };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return { status: "error", hits: [], detail: `HTTP ${answer.status}` };
  }
  let hits: T[];
  try {
    hits = engine.parse(answer).slice(0, limit);
  } catch (error) {
    // A block page can be what makes a parser throw: HTML where JSON was expected.
    if (engine.blocked?.(answer)) return blockPage;
    return { status: "error", hits: [], detail: `unreadable answer: ${messageOf(error)}` };
  }
  if (hits.length > 0) return { status: "ok", hits };
  if (engine.blocked?.(answer)) return blockPage;
  return { status: "empty", hits: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
