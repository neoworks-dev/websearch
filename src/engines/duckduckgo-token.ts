// DuckDuckGo's JSON endpoints (news.js, i.js) want a "vqd" token issued for the query, which its
// search page carries. So those engines read the page first: two requests per search.
import { EngineBlockedError, type RequestOptions } from "../types.ts";

/** The vqd token for `query`, from DuckDuckGo's search page. */
export async function duckduckgoToken(query: string, options: RequestOptions): Promise<string> {
  const page = await options.get(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
  // The page carries it as vqd="4-1234…", vqd='…' or vqd=4-1234…&.
  const token = /vqd=["']?([\d-]+)/.exec(page.body)?.[1];
  if (token) return token;
  if (page.status !== 200 || /anomaly|challenge/i.test(page.body)) {
    throw new EngineBlockedError("DuckDuckGo's search page is a block page");
  }
  throw new Error("DuckDuckGo's search page has no vqd token");
}

/** DuckDuckGo's region code for a language: "us-en" for English, else no region. */
export function duckduckgoRegion(language: string): string {
  return language === "en" ? "us-en" : "wt-wt";
}

/** A JSON endpoint's refusal, given in place of results. */
export const DUCKDUCKGO_JSON_BLOCK = /botnet_challenge|"response_type":\s*"challenge"/;
