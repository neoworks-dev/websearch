// The web engines read from their results pages. Selectors follow ddgs
// (https://github.com/deedy5/ddgs, MIT) where it has the engine, checked against pages saved in
// test/fixtures. The safe-search parameters were checked against live results.
import type { SafeSearch } from "../types.ts";
import { htmlEngine, isOn } from "./html.ts";

const q = encodeURIComponent;

/** Each engine's word for a safe-search level. */
function level<T extends string>(levels: Record<SafeSearch, T>): (safeSearch: SafeSearch) => T {
  return (safeSearch) => levels[safeSearch];
}

const bingSafeSearch = level({ strict: "strict", moderate: "moderate", off: "off" });

export const bing = htmlEngine({
  name: "bing",
  weight: 1,
  safeSearch: "supported",
  url: (query, options) =>
    `https://www.bing.com/search?q=${q(query)}&adlt=${bingSafeSearch(options.safeSearch)}`,
  selectors: { result: "li.b_algo", link: "h2 a", title: "h2", snippet: "p" },
  blockedBy: /captcha|\/challenge\b/i,
  unwrap(url) {
    if (!isOn(url, "bing.com")) return url.href;
    // bing.com/ck/a?…&u=a1<base64url of the target>; anything else on bing.com is Bing's own.
    const wrapped = url.pathname === "/ck/a" ? url.searchParams.get("u") : null;
    if (!wrapped?.startsWith("a1")) return undefined;
    const target = Buffer.from(wrapped.slice(2), "base64url").toString();
    return /^https?:\/\//.test(target) ? target : undefined;
  },
});

/** DuckDuckGo's documented `kp` values (also `p` on its JSON endpoints). */
export const duckduckgoSafeSearch = level({ strict: "1", moderate: "-1", off: "-2" });

/** DuckDuckGo's no-JavaScript "lite" page, the one it blocks least; its results are Bing's. */
export const duckduckgo = htmlEngine({
  name: "duckduckgo",
  weight: 1,
  safeSearch: "supported",
  url: (query, options) =>
    `https://lite.duckduckgo.com/lite/?q=${q(query)}&kp=${duckduckgoSafeSearch(options.safeSearch)}`,
  selectors: {
    result: "a.result-link",
    link: "a.result-link",
    title: "a.result-link",
    snippet: "td.result-snippet",
    following: true,
  },
  blockedBy: /anomaly-modal|challenge-form|anomaly\.js/,
  unwrap(url) {
    if (!isOn(url, "duckduckgo.com")) return url.href;
    // duckduckgo.com/l/?uddg=<target> is a redirect; y.js is an ad.
    return url.pathname === "/l/" ? (url.searchParams.get("uddg") ?? undefined) : undefined;
  },
});

const braveSafeSearch = level({ strict: "strict", moderate: "moderate", off: "off" });

export const brave = htmlEngine({
  name: "brave",
  weight: 1,
  safeSearch: "supported",
  url: (query) => `https://search.brave.com/search?q=${q(query)}&source=web`,
  // Brave reads the setting from a cookie only.
  init: (options) => ({ headers: { cookie: `safesearch=${braveSafeSearch(options.safeSearch)}` } }),
  selectors: {
    result: 'div[data-type="web"]',
    link: ".result-content > a",
    title: ".result-content .title",
    snippet: ".generic-snippet .content",
  },
  blockedBy: /captcha/i,
  unwrap: (url) => (isOn(url, "brave.com") ? undefined : url.href),
});

const startpageSafeSearch = level({ strict: "heavy", moderate: "moderate", off: "none" });

/** Startpage serves Google's results. */
export const startpage = htmlEngine({
  name: "startpage",
  weight: 1,
  safeSearch: "supported",
  url: (query, options) =>
    `https://www.startpage.com/sp/search?query=${q(query)}&qadf=${startpageSafeSearch(options.safeSearch)}`,
  selectors: {
    result: "div.result",
    link: "a.result-title",
    title: "h2",
    snippet: "p.description",
  },
  blockedBy: /anubis|captcha/i,
  unwrap: (url) => (isOn(url, "startpage.com") ? undefined : url.href),
});

/**
 * Yandex's site-search widget endpoint, which answers without a captcha more often. It has no
 * safe-search setting, so "strict" leaves it out.
 */
export const yandex = htmlEngine({
  name: "yandex",
  weight: 0.7,
  safeSearch: "unsupported",
  url: (query) => {
    const searchId = 1_000_000 + Math.floor(Math.random() * 9_000_000);
    return `https://yandex.com/search/site/?text=${q(query)}&web=1&searchid=${searchId}`;
  },
  selectors: {
    result: "li.b-serp-item",
    link: "h3 a",
    title: "h3",
    snippet: ".b-serp-item__text",
  },
  blockedBy: /showcaptcha|captcha/i,
  unwrap: (url) => (isOn(url, "yandex.com") || isOn(url, "yandex.ru") ? undefined : url.href),
});
