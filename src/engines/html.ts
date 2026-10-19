// An engine that scrapes a results page: a URL, selectors, and what its block page looks like.
import { absoluteUrl, extractHits, type ResultSelectors } from "../extract.ts";
import type { Engine, Hit, RequestOptions } from "../types.ts";

export interface HtmlEngineSpec {
  name: string;
  weight: number;
  url(query: string, options: RequestOptions): string;
  selectors: ResultSelectors;
  /** Matched against the final URL and the page when no results were found. */
  blockedBy: RegExp;
  /** The real target of a result link (unwrapping the engine's redirect); undefined drops it. */
  unwrap?(url: URL): string | undefined;
}

export function htmlEngine(spec: HtmlEngineSpec): Engine {
  return {
    name: spec.name,
    weight: spec.weight,
    request: (query, options) => ({ url: spec.url(query, options) }),
    parse(response) {
      const hits: Hit[] = [];
      const seen = new Set<string>();
      for (const raw of extractHits(response.body, spec.selectors)) {
        const absolute = absoluteUrl(raw.href, response.url);
        const url = absolute && spec.unwrap ? spec.unwrap(new URL(absolute)) : absolute;
        if (!url || !raw.title || seen.has(url)) continue;
        seen.add(url);
        hits.push({ url, title: raw.title, snippet: raw.snippet });
      }
      return hits;
    },
    blocked: (response) => spec.blockedBy.test(response.url) || spec.blockedBy.test(response.body),
  };
}

/** The language as a safe subdomain or parameter value: "en", "de", "pt-br"; else "en". */
export function languageCode(language: string): string {
  const code = language.toLowerCase();
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code) ? code : "en";
}
