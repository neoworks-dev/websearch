// The engines read from their HTML pages. Selectors follow ddgs (https://github.com/deedy5/ddgs,
// MIT) where it has the engine, checked against pages saved in test/fixtures.
import { htmlEngine } from "./html.ts";

const q = encodeURIComponent;

/** True when a link points back into the engine itself (related searches, images, ads). */
function isOn(url: URL, host: string): boolean {
  return url.hostname === host || url.hostname.endsWith(`.${host}`);
}

export const bing = htmlEngine({
  name: "bing",
  weight: 1,
  url: (query) => `https://www.bing.com/search?q=${q(query)}`,
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

/** DuckDuckGo's no-JavaScript "lite" page, the one it blocks least; its results are Bing's. */
export const duckduckgo = htmlEngine({
  name: "duckduckgo",
  weight: 1,
  url: (query) => `https://lite.duckduckgo.com/lite/?q=${q(query)}`,
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

export const brave = htmlEngine({
  name: "brave",
  weight: 1,
  url: (query) => `https://search.brave.com/search?q=${q(query)}&source=web`,
  selectors: {
    result: 'div[data-type="web"]',
    link: ".result-content > a",
    title: ".result-content .title",
    snippet: ".generic-snippet .content",
  },
  blockedBy: /captcha/i,
  unwrap: (url) => (isOn(url, "brave.com") ? undefined : url.href),
});

/** Startpage serves Google's results. */
export const startpage = htmlEngine({
  name: "startpage",
  weight: 1,
  url: (query) => `https://www.startpage.com/sp/search?query=${q(query)}`,
  selectors: {
    result: "div.result",
    link: "a.result-title",
    title: "h2",
    snippet: "p.description",
  },
  blockedBy: /anubis|captcha/i,
  unwrap: (url) => (isOn(url, "startpage.com") ? undefined : url.href),
});

/** Yandex's site-search widget endpoint, which answers without a captcha more often. */
export const yandex = htmlEngine({
  name: "yandex",
  weight: 0.7,
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
