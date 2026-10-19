// Engines that scrape a results page: a URL, selectors, and what the engine's block page looks
// like. `htmlEngine` is for web results (a link, a title, a snippet); `mappedHtmlEngine` builds
// any kind of result from what the selectors read (news, images).
import { absoluteUrl, extractHits, type RawHit, type ResultSelectors } from "../extract.ts";
import type { Engine, Hit, RequestOptions } from "../types.ts";

interface Spec {
  name: string;
  weight: number;
  safeSearch: Engine["safeSearch"];
  url(query: string, options: RequestOptions): string;
  /** What the request needs beyond the browser-like defaults (a cookie, say). */
  init?(options: RequestOptions): RequestInit;
  selectors: ResultSelectors;
  /** Matched against the final URL and the page when no results were found. */
  blockedBy: RegExp;
}

export interface HtmlEngineSpec extends Spec {
  /** The real target of a result link (unwrapping the engine's redirect); undefined drops it. */
  unwrap?(url: URL): string | undefined;
}

export interface MappedHtmlEngineSpec<T extends Hit> extends Spec {
  /** A result from what the page had, or undefined to drop it. */
  toHit(raw: RawHit, pageUrl: string): T | undefined;
  /** What makes two results the same, so each is listed once; their URL by default. */
  key?(hit: T): string;
}

export function mappedHtmlEngine<T extends Hit>(spec: MappedHtmlEngineSpec<T>): Engine<T> {
  const key = (hit: T): string => spec.key?.(hit) ?? hit.url;
  return {
    name: spec.name,
    weight: spec.weight,
    safeSearch: spec.safeSearch,
    request: (query, options) => {
      const init = spec.init?.(options);
      return init ? { url: spec.url(query, options), init } : { url: spec.url(query, options) };
    },
    parse(response) {
      const hits: T[] = [];
      const seen = new Set<string>();
      for (const raw of extractHits(response.body, spec.selectors)) {
        const hit = spec.toHit(raw, response.url);
        if (!hit || seen.has(key(hit))) continue;
        seen.add(key(hit));
        hits.push(hit);
      }
      return hits;
    },
    blocked: (response) => spec.blockedBy.test(response.url) || spec.blockedBy.test(response.body),
  };
}

export function htmlEngine(spec: HtmlEngineSpec): Engine {
  return mappedHtmlEngine({
    ...spec,
    toHit(raw, pageUrl) {
      const absolute = absoluteUrl(raw.href, pageUrl);
      const url = absolute && spec.unwrap ? spec.unwrap(new URL(absolute)) : absolute;
      if (!url || !raw.title) return undefined;
      return { url, title: raw.title, snippet: raw.snippet };
    },
  });
}

/** The language as a safe subdomain or parameter value: "en", "de", "pt-br"; else "en". */
export function languageCode(language: string): string {
  const code = language.toLowerCase();
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code) ? code : "en";
}

/** True when a link points back into the engine itself (related searches, images, ads). */
export function isOn(url: URL, host: string): boolean {
  return url.hostname === host || url.hostname.endsWith(`.${host}`);
}
