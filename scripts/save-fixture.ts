// Saves an engine's answer as a test fixture: `bun scripts/save-fixture.ts bing`.
//
// When an engine's layout changes, its parser test still passes against the old page while the
// live check fails. Save a fresh page with this, fix the selectors until `bun test` passes
// again, and commit both. From HTML pages, scripts, styles, SVGs and comments are cut, which
// leaves the markup the selectors read at a fraction of the size.
//
//   bun scripts/save-fixture.ts <engine> [query]        fetch the answer now
//   bun scripts/save-fixture.ts <engine> --from <file>  use an answer saved some other way
import {
  DEFAULT_USER_AGENT,
  imageEngines,
  newsEngines,
  webEngines,
  type Engine,
  type EngineResponse,
  type Hit,
  type RequestOptions,
} from "../src/index.ts";

/** The question each fixture answers, per kind of engine. */
const QUERIES = {
  web: "deepseek v4.1 flash 1017",
  news: "deepseek",
  images: "deepseek logo",
};

const engines: [Engine<Hit>, string][] = [
  ...webEngines.map((engine): [Engine<Hit>, string] => [engine, QUERIES.web]),
  ...newsEngines.map((engine): [Engine<Hit>, string] => [engine, QUERIES.news]),
  ...imageEngines.map((engine): [Engine<Hit>, string] => [engine, QUERIES.images]),
];

function strip(html: string): string {
  return new HTMLRewriter()
    .on("script, style, svg, noscript, link, meta", {
      element(element) {
        element.remove();
      },
    })
    .onDocument({
      comments(comment) {
        comment.remove();
      },
    })
    .transform(html)
    .replace(/\n\s*\n+/g, "\n");
}

async function get(url: string, init?: RequestInit): Promise<EngineResponse> {
  const headers = new Headers({
    "user-agent": DEFAULT_USER_AGENT,
    "accept-language": "en-US,en;q=0.9",
  });
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const response = await fetch(url, { ...init, headers });
  return { status: response.status, url: response.url, body: await response.text() };
}

const options: RequestOptions = { limit: 10, language: "en", safeSearch: "moderate", get };

const [name, ...rest] = process.argv.slice(2);
const found = engines.find(([candidate]) => candidate.name === name);
if (!found) {
  const names = engines.map(([candidate]) => candidate.name).join(", ");
  process.stderr.write(`usage: bun scripts/save-fixture.ts <${names}> [query | --from file]\n`);
  process.exit(2);
}
const [engine, defaultQuery] = found;

let answer: EngineResponse;
if (rest[0] === "--from" && rest[1]) {
  answer = { status: 200, url: "", body: await Bun.file(rest[1]).text() };
} else {
  const request = await engine.request(rest.join(" ") || defaultQuery, options);
  answer = await get(request.url, request.init);
  process.stdout.write(`${answer.status} ${answer.url}\n`);
}

const json = /^\s*[[{]/.test(answer.body);
const body = json ? answer.body : strip(answer.body);
const path = new URL(`../test/fixtures/${engine.name}.${json ? "json" : "html"}`, import.meta.url)
  .pathname;
await Bun.write(path, body);
const hits = engine.parse({ ...answer, url: answer.url || "https://example.com/", body });
process.stdout.write(`${path}: ${Math.round(body.length / 1024)} KB, ${hits.length} results\n`);
