// Asks every engine at once, gives each a few seconds, and merges what came back. An engine that
// refuses us is reported as blocked rather than as having found nothing, and sits out a while.
import { mwmbl, wikipedia } from "./engines/apis.ts";
import { languageCode } from "./engines/html.ts";
import { DEFAULT_USER_AGENT, type Fetch } from "./http.ts";
import { bing, brave, duckduckgo, startpage, yandex } from "./engines/scraped.ts";
import { mergeHits, type Result } from "./merge.ts";
import type { Engine, EngineResponse, Hit } from "./types.ts";

/** The keyless engines. SearXNG and TinyFish need an instance or a key, so they are added. */
export const defaultEngines: readonly Engine[] = [
  bing,
  duckduckgo,
  brave,
  startpage,
  yandex,
  wikipedia,
  mwmbl,
];

export interface SearchOptions {
  engines?: readonly Engine[];
  /** At most this many results; 10. */
  limit?: number;
  /** "en", "de", …; "en". */
  language?: string;
  /** How long each engine gets; 6 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: Fetch;
  userAgent?: string;
  /** Where blocked engines are remembered; the shared one, or false to ask every engine anyway. */
  cooldown?: Cooldown | false;
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
  | "cooling";

export interface EngineReport {
  engine: string;
  status: EngineStatus;
  results: number;
  ms: number;
  /** For "error" and "blocked": what happened. */
  detail?: string;
}

export interface SearchResponse {
  query: string;
  results: Result[];
  /** One per engine asked, in the order given. */
  engines: EngineReport[];
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

/** The browser-like defaults, then the engine's own headers (an API key, an Accept). */
function headers(init: RequestInit | undefined, options: SearchOptions): Headers {
  const language = languageCode(options.language ?? "en");
  const merged = new Headers({
    "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": language === "en" ? "en-US,en;q=0.9" : `${language},en;q=0.8`,
  });
  new Headers(init?.headers).forEach((value, name) => merged.set(name, value));
  return merged;
}

/**
 * Asks one engine and judges its answer. `search` does this for every engine; the live check
 * calls it directly. The cooldown isn't consulted here.
 */
export async function queryEngine(
  engine: Engine,
  query: string,
  options: SearchOptions = {},
): Promise<{ hits: Hit[]; report: EngineReport }> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 6000);
  let outcome: Outcome;
  try {
    const answer = await ask(engine, query, options, timeout);
    outcome = judge(engine, answer, options.limit ?? 10);
  } catch (error) {
    options.signal?.throwIfAborted();
    outcome = timeout.aborted
      ? { status: "timeout", hits: [] }
      : { status: "error", hits: [], detail: messageOf(error) };
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

interface Outcome {
  status: EngineStatus;
  hits: Hit[];
  detail?: string;
}

/** Fetches the engine's page for `query`. */
async function ask(
  engine: Engine,
  query: string,
  options: SearchOptions,
  timeout: AbortSignal,
): Promise<EngineResponse> {
  const request = engine.request(query, {
    limit: options.limit ?? 10,
    language: languageCode(options.language ?? "en"),
  });
  const response = await (options.fetch ?? fetch)(request.url, {
    ...request.init,
    headers: headers(request.init, options),
    redirect: "follow",
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  return { status: response.status, url: response.url || request.url, body: await response.text() };
}

/** What an answer means: results, a refusal, nothing, or a failure. */
function judge(engine: Engine, answer: EngineResponse, limit: number): Outcome {
  const blockPage: Outcome = { status: "blocked", hits: [], detail: "block page" };
  if (REFUSING.has(answer.status)) {
    return { status: "blocked", hits: [], detail: `HTTP ${answer.status}` };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return { status: "error", hits: [], detail: `HTTP ${answer.status}` };
  }
  let hits: Hit[];
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

/** Searches the web with every engine at once and merges the results. */
export async function search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const trimmed = query.trim();
  if (trimmed === "") throw new Error("The query is empty");
  const cooldown = options.cooldown === false ? undefined : (options.cooldown ?? sharedCooldown);
  const engines = options.engines ?? defaultEngines;
  const runs = await Promise.all(
    engines.map(async (engine) => {
      if (cooldown?.cooling(engine.name)) {
        return {
          engine,
          hits: [],
          report: { engine: engine.name, status: "cooling", results: 0, ms: 0 } as const,
        };
      }
      const run = await queryEngine(engine, trimmed, options);
      if (run.report.status === "blocked") cooldown?.blocked(engine.name);
      if (run.report.status === "ok") cooldown?.answered(engine.name);
      return { engine, ...run };
    }),
  );
  options.signal?.throwIfAborted();
  return {
    query: trimmed,
    results: mergeHits(runs, options.limit ?? 10),
    engines: runs.map((run) => run.report),
  };
}
