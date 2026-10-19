// Several engines' lists made one: the same page found by more engines, and higher up, ranks
// higher. The score is SearXNG's idea: each engine adds its weight divided by the position.
import type { Engine, Hit } from "./types.ts";

export interface Result extends Hit {
  /** The engines that found it, best placed first. */
  engines: string[];
  score: number;
}

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

interface Entry {
  result: Result;
  /** Each engine's share of the score, for ordering `engines`. */
  shares: Map<string, number>;
}

export function mergeHits(lists: { engine: Engine; hits: Hit[] }[], limit: number): Result[] {
  const entries = new Map<string, Entry>();
  for (const { engine, hits } of lists) {
    hits.forEach((hit, index) => {
      const share = engine.weight / (index + 1);
      const key = normalizeUrl(hit.url);
      const entry = entries.get(key);
      if (!entry) {
        entries.set(key, {
          result: { ...hit, engines: [], score: 0 },
          shares: new Map([[engine.name, share]]),
        });
        return;
      }
      if (entry.shares.has(engine.name)) return;
      entry.shares.set(engine.name, share);
      // The longest snippet says the most; the first title stays.
      if (hit.snippet.length > entry.result.snippet.length) entry.result.snippet = hit.snippet;
      if (entry.result.url.startsWith("http:") && hit.url.startsWith("https:")) {
        entry.result.url = hit.url;
      }
    });
  }
  const results = [...entries.values()].map(({ result, shares }) => {
    const ranked = [...shares.entries()].sort((a, b) => b[1] - a[1]);
    return {
      ...result,
      engines: ranked.map(([name]) => name),
      score: ranked.reduce((sum, [, share]) => sum + share, 0),
    };
  });
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
