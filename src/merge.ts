// Several engines' lists made one: the same page (or image) found by more engines, and higher
// up, ranks higher. The score is SearXNG's idea: each engine adds its weight divided by the
// position it gave the result.
import type { Engine, Hit } from "./types.ts";

/** A merged result: what the engines found, and which of them found it. */
export type Result<T extends Hit = Hit> = T & {
  /** The engines that found it, best placed first. */
  engines: string[];
  score: number;
};

/** Tracking parameters that make one page look like several. */
const TRACKING = /^(utm_.*|fbclid|gclid|msclkid|ref_src|ref)$/;

/** The key two links to the same page share: no scheme, "www.", fragment or trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING.test(key)) parsed.searchParams.delete(key);
    }
    // `host` keeps a non-default port: example.com:8080 is another site.
    const host = parsed.host.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

interface Entry<T extends Hit> {
  result: T;
  /** Each engine's share of the score, for ordering `engines`. */
  shares: Map<string, number>;
}

/**
 * Merges the engines' lists. `key` says when two results are the same: by default their
 * normalized URL; image search uses the image's URL.
 */
export function mergeHits<T extends Hit>(
  lists: { engine: Engine<T>; hits: T[] }[],
  limit: number,
  key: (hit: T) => string = (hit) => normalizeUrl(hit.url),
): Result<T>[] {
  const entries = new Map<string, Entry<T>>();
  for (const { engine, hits } of lists) {
    hits.forEach((hit, index) => {
      const share = engine.weight / (index + 1);
      const entry = entries.get(key(hit));
      if (!entry) {
        entries.set(key(hit), { result: { ...hit }, shares: new Map([[engine.name, share]]) });
        return;
      }
      if (entry.shares.has(engine.name)) return;
      entry.shares.set(engine.name, share);
      // The first engine's values stay; what it lacked (a date, a source) comes from later ones.
      entry.result = { ...hit, ...entry.result };
      // The longest snippet says the most.
      if (hit.snippet.length > entry.result.snippet.length) entry.result.snippet = hit.snippet;
      if (entry.result.url.startsWith("http:") && hit.url.startsWith("https:")) {
        entry.result.url = hit.url;
      }
    });
  }
  const results = [...entries.values()].map(({ result, shares }): Result<T> => {
    const ranked = [...shares.entries()].sort((a, b) => b[1] - a[1]);
    return {
      ...result,
      engines: ranked.map(([name]) => name),
      score: ranked.reduce((sum, [, share]) => sum + share, 0),
    };
  });
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
