# websearch

Web search and page fetching for AI agents, with no API key, no Python and no browser.

`search` asks several search engines at once and merges their results into one ranked list.
`fetchPage` turns a page into markdown that an agent can grep, instead of a summary someone else
wrote. Everything runs in-process on Bun's `fetch` and `HTMLRewriter`, and the package has no
dependencies.

```ts
import { fetchPage, search } from "@neoworks/websearch";

const { results, engines } = await search("deepseek v4.1 flash 1017");
const page = await fetchPage(results[0].url);
```

## Contents

- [Requirements](#requirements)
- [Searching](#searching)
- [Engines](#engines)
- [Fetching pages](#fetching-pages)
- [How it works](#how-it-works)
- [Adding an engine](#adding-an-engine)
- [When an engine breaks](#when-an-engine-breaks)
- [Limits](#limits)
- [Development](#development)
- [Credits](#credits)

## Requirements

Bun 1.2 or newer; tested with 1.3. The parsers use Bun's built-in
[`HTMLRewriter`](https://bun.sh/docs/api/html-rewriter), so Node.js is not supported.

The package isn't on npm yet. Inside this monorepo it's a workspace package:

```json
{ "dependencies": { "@neoworks/websearch": "workspace:*" } }
```

## Searching

```ts
const response = await search("deepseek v4.1 flash 1017", { limit: 5 });
```

`results` is one list for all engines, best first. Each result says which engines found it:

```ts
[
  {
    url: "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017",
    title: "deepseek-ai/DeepSeek-V4.1-Flash-1017 · Hugging Face",
    snippet: "2 days ago - DeepSeek-V4.1-Flash-1017 is a minor update to DeepSeek-V4.1-Flash, …",
    engines: ["bing", "brave", "startpage"],
    score: 3,
  },
  {
    url: "https://api-docs.deepseek.com/news/news261017/",
    title: "DeepSeek-V4.1-Flash-1017: Wish-Driven Programming Made Real",
    snippet: "2 days ago - DeepSeek-V4.1-Flash-1017 uses reinforcement learning with self-feed…",
    engines: ["brave", "startpage", "bing"],
    score: 1.25,
  },
  // …
];
```

`engines` reports how each engine did, so a block shows up instead of quietly thinning the
results:

```ts
[
  { engine: "bing", status: "ok", results: 10, ms: 249 },
  { engine: "duckduckgo", status: "blocked", results: 0, ms: 205, detail: "HTTP 202" },
  { engine: "brave", status: "ok", results: 10, ms: 767 },
  // …
];
```

| Status    | Meaning                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| `ok`      | Results came back.                                                            |
| `empty`   | A normal page with no results: nothing was found, or the page layout changed. |
| `blocked` | A captcha, a challenge page, or a status such as 429 that means "not you".    |
| `timeout` | No answer within `timeoutMs`.                                                 |
| `error`   | A network error, an unexpected status, or an answer the parser couldn't read. |
| `cooling` | Blocked recently, so not asked this time (see [How it works](#how-it-works)). |

### Options

| Option      | Default            | What it does                                                             |
| ----------- | ------------------ | ------------------------------------------------------------------------ |
| `engines`   | `defaultEngines`   | The engines to ask.                                                      |
| `limit`     | `10`               | At most this many results, and per engine.                               |
| `language`  | `"en"`             | A language code, sent as `Accept-Language` and to engines that take one. |
| `timeoutMs` | `6000`             | How long each engine gets.                                               |
| `signal`    |                    | Aborts the search; `search` then rejects.                                |
| `fetch`     | `globalThis.fetch` | The fetch to use, for tests or a proxy.                                  |
| `userAgent` | a desktop Chrome   | Sent to the scraped engines.                                             |
| `cooldown`  | a shared one       | Where blocks are remembered; `false` asks every engine regardless.       |

Bun's `fetch` honours `HTTPS_PROXY` and `HTTP_PROXY`, so a proxy can also be set from the
environment.

## Engines

`defaultEngines` are the engines that need no key:

| Engine       | Source                               | Weight | Notes                                            |
| ------------ | ------------------------------------ | ------ | ------------------------------------------------ |
| `bing`       | bing.com results page                | 1      | Result links are unwrapped from Bing's redirect. |
| `duckduckgo` | DuckDuckGo's no-JavaScript lite page | 1      | Bing's index. Blocks quickly under load.         |
| `brave`      | search.brave.com results page        | 1      | Brave's own index.                               |
| `startpage`  | startpage.com results page           | 1      | Google's results.                                |
| `yandex`     | Yandex's site-search endpoint        | 0.7    | Yandex's index.                                  |
| `wikipedia`  | The MediaWiki search API             | 0.5    | At most 3 articles.                              |
| `mwmbl`      | The [Mwmbl](https://mwmbl.org) API   | 0.5    | A small open index run by volunteers.            |

Two more take an instance or a key, so they are added by hand:

```ts
import { defaultEngines, search, searxng, tinyfish } from "@neoworks/websearch";

await search("query", {
  engines: [
    ...defaultEngines,
    searxng("http://127.0.0.1:8888"), // needs `search.formats: [html, json]` in its settings
    tinyfish(process.env.TINYFISH_API_KEY), // https://docs.tinyfish.ai/search-api, free tier
  ],
});
```

Any list works, so you can also use fewer engines: `{ engines: [bing, brave, wikipedia] }`.

## Fetching pages

```ts
const page = await fetchPage("https://en.wikipedia.org/wiki/TypeScript");
```

```ts
{
  url: "https://en.wikipedia.org/wiki/TypeScript",
  finalUrl: "https://en.wikipedia.org/wiki/TypeScript",
  status: 200,
  contentType: "text/html; charset=utf-8",
  title: "TypeScript - Wikipedia",
  content: "# TypeScript\n\n…\n\n## History\n\n…",
  bytes: 427909,
  truncated: false,
}
```

HTML becomes markdown. Other text types (plain text, JSON, XML) come back unchanged, and
anything else (PDFs, images) is refused with a `FetchPageError`.

Most pages are long and mostly not what the agent is after. The idea is to save `content` to a
file and let the agent search it, rather than putting the whole page into its context.

The markdown keeps headings, paragraphs, links (resolved to absolute URLs), lists, code blocks,
quotes, tables and images that have alt text. It drops scripts, styles, navigation, sidebars,
footers, form controls and hidden elements. When `<main>`, or a page's only `<article>`, holds
most of the text, only that part is used.

This is simpler than Mozilla's Readability: some pages keep a menu or a list of links. Since the
agent searches the file rather than reading all of it, that clutter costs little.

| Option                         | Default   | What it does                                  |
| ------------------------------ | --------- | --------------------------------------------- |
| `timeoutMs`                    | `20000`   | For the whole fetch, redirects included.      |
| `maxBytes`                     | `5000000` | The body is cut there and `truncated` is set. |
| `maxRedirects`                 | `5`       |                                               |
| `allowPrivateNetwork`          | `false`   | See below.                                    |
| `signal`, `fetch`, `userAgent` |           | As for `search`.                              |

### Private addresses

An agent picks the URLs `fetchPage` loads. So by default it refuses any host that resolves to
loopback, a private or link-local range, carrier-grade NAT, or another non-public address,
including cloud metadata at `169.254.169.254`. Redirects are followed one hop at a time, and
every hop is checked. Only `http:` and `https:` URLs are fetched.

The host is resolved once for the check and again by `fetch`. A DNS server that gives a
different answer the second time (DNS rebinding) is not caught. `isPublicAddress` and
`assertPublicUrl` are exported for doing the same check elsewhere.

## How it works

**One request per engine, all at once.** Each engine gets `timeoutMs`. A slow or broken engine
costs its own results and nothing else.

**Merging.** Results from different engines that point to the same page become one. URLs count as
the same page when they differ only in scheme, `www.`, a trailing slash, a fragment, or tracking
parameters (`utm_*`, `fbclid`, …). The score follows SearXNG: each engine that found the page
adds its weight divided by the page's position in its list. A page that three engines rank first
scores 3; one that a single engine ranks fifth scores 0.2. The longest snippet is kept.

**Blocked, not just empty.** An engine that refuses us usually still answers `200` with a page.
That page is a captcha, though, and has no results. Each engine knows what its block page looks
like (`blocked`), and that is checked whenever a page has no results, so "blocked" and "nothing
found" are reported apart.

**Cooldown.** A blocked engine is left out for 15 minutes, then 30, doubling up to 6 hours. One
good answer clears it. Querying an engine while it's blocking you only makes the block last
longer. The cooldown is shared by every `search` call in the process unless you pass your own
`new Cooldown()`.

## Adding an engine

An engine is a table: the URL to ask, the CSS selectors of its results, and a pattern that
recognizes its block page.

```ts
import { htmlEngine } from "@neoworks/websearch";

export const example = htmlEngine({
  name: "example",
  weight: 1,
  url: (query) => `https://search.example/?q=${encodeURIComponent(query)}`,
  selectors: {
    result: "div.result", // each match starts a result
    link: "a.title", // its href is the URL
    title: "a.title",
    snippet: "p.summary",
  },
  blockedBy: /captcha|unusual traffic/i,
  // Optional: unwrap the engine's redirect links, or drop links back into the engine.
  unwrap: (url) => (url.hostname.endsWith("search.example") ? undefined : url.href),
});
```

The selectors are the subset `HTMLRewriter` supports: type, class, id and attribute selectors,
with descendant and child combinators. Engines with a JSON API implement `Engine` directly. Its
`request` and `parse` are all there is (see `src/engines/apis.ts`).

Then:

1. Add it to `defaultEngines` in `src/search.ts` if it needs no key, and save a results page as
   its fixture: `bun scripts/save-fixture.ts example`.
2. Add it to the table in `test/engines.test.ts`, with the number of results the fixture has.
3. Run `bun scripts/live-check.ts example` to see it answer for real.

## When an engine breaks

Search pages change, and engines start blocking clients they used to serve. The tests can't
notice either, since they read saved pages. So a GitHub workflow,
[`websearch-live.yml`](../.github/workflows/websearch-live.yml), asks every engine one real
question each day. It fails when an engine is blocked, comes back empty, or returns fewer results
than expected, and lists every engine in the job summary.

GitHub's runners sit in data centres, which search engines block far more readily than home
connections. To check from a residential IP, set one of these repository secrets:

- `WEBSEARCH_PROXY`: an HTTP(S) proxy URL, `http://user:password@host:port`;
- `WEBSEARCH_WIREGUARD`: a WireGuard configuration file.

When the check fails:

- **`blocked`**: the engine refuses us. If it keeps happening from a residential IP, consider
  dropping the engine from `defaultEngines`, or lowering its weight.
- **`empty`, or too few results**: the page layout changed. Save a fresh page with
  `bun scripts/save-fixture.ts <engine>` and adjust the selectors until `bun test` passes again.
  Then commit the fixture and the fix together.

To run the same check locally: `bun scripts/live-check.ts` (all engines) or
`bun scripts/live-check.ts bing brave`.

## Limits

- **Scraping.** Five of the engines are read from pages meant for people. Their terms of
  service don't invite this. Use it at the volume of a person searching, not of a crawler.
- **Rate limits.** Engines block quickly when asked often from one address. DuckDuckGo started
  blocking after about ten queries in an afternoon. The cooldown keeps a blocked engine from
  being asked again; it can't prevent the first block.
- **No JavaScript.** Pages that only render in a browser come back mostly empty, and engines
  that need JavaScript (Google) or a proof-of-work captcha (Mojeek) aren't included.
- **Text only.** PDFs and other binary documents are refused.

## Development

```sh
bun test                           # parsers against saved pages, merging, fetching, the guard
bun scripts/live-check.ts          # every engine, live
bun scripts/save-fixture.ts bing   # refresh a fixture
```

The package follows the monorepo's lint and format setup (`bunx oxlint --type-aware`,
`bunx prettier --check`).

## Credits

- The engine selectors follow [ddgs](https://github.com/deedy5/ddgs) (MIT) where ddgs has the
  engine.
- The merge score is the one [SearXNG](https://github.com/searxng/searxng) uses. No SearXNG code
  is included.

## License

MIT, see [LICENSE](LICENSE).
