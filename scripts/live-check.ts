// Asks every engine one real question and fails unless each one answered with results. The
// tests read saved pages, so they can't tell when an engine starts blocking us or changes its
// layout; this can. It runs daily in CI (.github/workflows/websearch-live.yml) and by hand:
//
//   bun scripts/live-check.ts                     every engine (web, news, images) and a page fetch
//   bun scripts/live-check.ts bing bing-news      only these
//
// Exit code 1 when anything failed. In GitHub Actions the table also goes to the job summary.
import { appendFile } from "node:fs/promises";
import {
  fetchPage,
  FetchPageError,
  imageEngines,
  newsEngines,
  queryEngine,
  webEngines,
  type Engine,
  type EngineReport,
  type Hit,
} from "../src/index.ts";

/** Questions each kind of engine has results for, and will have for years. */
const CHECKS: { engines: readonly Engine<Hit>[]; query: string }[] = [
  { engines: webEngines, query: "typescript programming language" },
  // There is news about technology every day.
  { engines: newsEngines, query: "technology" },
  { engines: imageEngines, query: "typescript logo" },
];

/** Fewer results than this is a failure too: a half-broken parser still finds one or two. */
const MIN_RESULTS: Record<string, number> = { wikipedia: 1 };
const DEFAULT_MIN_RESULTS = 3;

/** A page that changes little, for checking fetching and markdown. */
const PAGE = "https://en.wikipedia.org/wiki/TypeScript";

interface Row {
  check: string;
  ok: boolean;
  status: string;
  results: string;
  ms: number;
  detail: string;
}

function engineRow(report: EngineReport): Row {
  const needed = MIN_RESULTS[report.engine] ?? DEFAULT_MIN_RESULTS;
  const ok = report.status === "ok" && report.results >= needed;
  let detail = report.detail ?? "";
  if (report.status === "ok" && !ok) detail = `fewer than ${needed} results`;
  return {
    check: report.engine,
    ok,
    status: report.status,
    results: String(report.results),
    ms: report.ms,
    detail,
  };
}

async function pageRow(): Promise<Row> {
  const started = performance.now();
  const row = (ok: boolean, status: string, results: string, detail: string): Row => ({
    check: "fetchPage",
    ok,
    status,
    results,
    ms: Math.round(performance.now() - started),
    detail,
  });
  try {
    const page = await fetchPage(PAGE);
    const size = `${page.content.length} chars`;
    if (page.problem) return row(false, page.problem.kind, size, page.problem.detail);
    // The article mentions its maker; without it, the markdown lost the article.
    if (!page.content.includes("Microsoft"))
      return row(false, "wrong", size, "the article is missing");
    return row(true, "ok", size, `"${page.title ?? ""}"`);
  } catch (error) {
    if (error instanceof FetchPageError) return row(false, error.code, "", error.message);
    throw error;
  }
}

function table(rows: Row[]): string {
  const lines = rows.map(
    (row) =>
      `| ${row.ok ? "✅" : "❌"} ${row.check} | ${row.status} | ${row.results} | ${row.ms} ms | ${row.detail.replaceAll("|", "\\|")} |`,
  );
  return [
    "| check | status | results | time | detail |",
    "| --- | --- | --- | --- | --- |",
    ...lines,
  ].join("\n");
}

const wanted = process.argv.slice(2);
const asks = CHECKS.flatMap(({ engines, query }) =>
  engines
    .filter((engine) => wanted.length === 0 || wanted.includes(engine.name))
    .map((engine) => ({ engine, query })),
);

const reports = await Promise.all(
  asks.map(
    async ({ engine, query }) => (await queryEngine(engine, query, { timeoutMs: 15_000 })).report,
  ),
);
const rows = reports.map(engineRow);
// Naming engines checks only those; the page fetch is checked when everything is.
if (wanted.length === 0) rows.push(await pageRow());
const failed = rows.filter((row) => !row.ok);

const summary = [
  `### websearch live check: ${failed.length === 0 ? "all good" : `${failed.length} failed`}`,
  "",
  `Queries: ${CHECKS.map(({ query }) => `\`${query}\``).join(", ")}`,
  "",
  table(rows),
  "",
].join("\n");
process.stdout.write(`${summary}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(failed.length === 0 ? 0 : 1);
