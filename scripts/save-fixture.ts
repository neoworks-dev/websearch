// Saves an engine's results page as a test fixture: `bun scripts/save-fixture.ts bing`.
//
// When an engine's layout changes, its parser test still passes against the old page while the
// live check fails. Save a fresh page with this, fix the selectors until `bun test` passes
// again, and commit both. Scripts, styles, SVGs and comments are cut from the page, which leaves
// the markup the selectors read at a fraction of the size.
//
//   bun scripts/save-fixture.ts <engine> [query]       fetch the page now
//   bun scripts/save-fixture.ts <engine> --from <file> use a page saved some other way
import { defaultEngines, DEFAULT_USER_AGENT } from "../src/index.ts";

export const FIXTURE_QUERY = "deepseek v4.1 flash 1017";

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

const [name, ...rest] = process.argv.slice(2);
const engine = defaultEngines.find((candidate) => candidate.name === name);
if (!engine) {
  const names = defaultEngines.map((candidate) => candidate.name).join(", ");
  process.stderr.write(`usage: bun scripts/save-fixture.ts <${names}> [query | --from file]\n`);
  process.exit(2);
}

let html: string;
if (rest[0] === "--from" && rest[1]) {
  html = await Bun.file(rest[1]).text();
} else {
  const request = engine.request(rest.join(" ") || FIXTURE_QUERY, { limit: 10, language: "en" });
  const headers = new Headers({
    "user-agent": DEFAULT_USER_AGENT,
    "accept-language": "en-US,en;q=0.9",
  });
  new Headers(request.init?.headers).forEach((value, name) => headers.set(name, value));
  const response = await fetch(request.url, { ...request.init, headers });
  html = await response.text();
  process.stdout.write(`${response.status} ${response.url}\n`);
}

const path = new URL(`../test/fixtures/${engine.name}.html`, import.meta.url).pathname;
const stripped = strip(html);
await Bun.write(path, stripped);
const hits = engine.parse({
  status: 200,
  url: engine.request("x", { limit: 10, language: "en" }).url,
  body: stripped,
});
process.stdout.write(`${path}: ${Math.round(stripped.length / 1024)} KB, ${hits.length} results\n`);
