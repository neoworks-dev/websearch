// A web page as markdown, for an agent to grep and read rather than to look at. Headings,
// paragraphs, links, lists, code, quotes and tables are kept; scripts, navigation, sidebars,
// footers and form controls are dropped.
//
// Two passes over the HTML with Bun's HTMLRewriter:
//   1. `scan` reads the title and description, and measures whether <main> (or a page's only
//      <article>) holds most of the text.
//   2. `htmlToMarkdown` writes that part, or the whole body when there is no such part, by
//      running one small rule per tag (see RULES).
//
// It is no Readability: a cluttered page keeps some clutter. Since the agent searches the file
// instead of reading all of it, leftover clutter costs little.
import { EndTags } from "./end-tags.ts";
import { decodeEntities, plainText } from "./entities.ts";
import { absoluteUrl } from "./extract.ts";

export interface Markdown {
  title?: string;
  description?: string;
  markdown: string;
}

/** Never page text, wherever they are. */
const HIDDEN = [
  "head",
  "title",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "nav",
  "aside",
  "footer",
  "button",
  "select",
  "textarea",
  "dialog",
  "[hidden]",
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="search"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="toolbar"]',
  '[role="contentinfo"]',
].join(", ");

const MAIN = 'main, [role="main"]';

/** A candidate root must hold at least this share of the page's text to be used. */
const ROOT_SHARE = 0.25;

// ---- pass 1: what the page is ----

interface PageScan {
  title?: string;
  description?: string;
  /** The page's <base href>, which relative links resolve against. */
  base?: string;
  /** Which part holds the content; undefined for the whole body. */
  root?: "main" | "article";
}

function scan(html: string): PageScan {
  const ends = new EndTags();
  const found: PageScan = {};
  let title = "";
  let titleSeen = false;
  let mainSeen = false;
  let articles = 0;
  const open = { title: 0, main: 0, article: 0, hidden: 0 };
  const text = { total: 0, main: 0, article: 0 };

  const rewriter = new HTMLRewriter()
    .on("title", {
      element(element) {
        if (titleSeen) return;
        titleSeen = true;
        if (ends.onClose(element, () => open.title--)) open.title++;
      },
    })
    .on('meta[name="description"], meta[property="og:description"]', {
      element(element) {
        found.description ??= plainText(element.getAttribute("content") ?? "") || undefined;
      },
    })
    .on("base[href]", {
      element(element) {
        found.base ??= decodeEntities(element.getAttribute("href") ?? "");
      },
    })
    .on(MAIN, {
      element(element) {
        if (mainSeen) return;
        mainSeen = true;
        if (ends.onClose(element, () => open.main--)) open.main++;
      },
    })
    .on("article", {
      element(element) {
        articles++;
        if (articles === 1 && ends.onClose(element, () => open.article--)) open.article++;
      },
    })
    .on(HIDDEN, {
      element(element) {
        if (ends.onClose(element, () => open.hidden--)) open.hidden++;
      },
    })
    .onDocument({
      text(chunk) {
        if (open.title > 0) title += chunk.text;
        if (open.hidden > 0) return;
        const length = chunk.text.trim().length;
        text.total += length;
        if (open.main > 0) text.main += length;
        if (open.article > 0) text.article += length;
      },
    });
  ends.attach(rewriter).transform(html);

  const pageTitle = plainText(title);
  if (pageTitle) found.title = pageTitle;
  if (mainSeen && text.main >= text.total * ROOT_SHARE) found.root = "main";
  else if (articles === 1 && text.article >= text.total * ROOT_SHARE) found.root = "article";
  return found;
}

// ---- the output ----

/**
 * The markdown being written. Links, table cells and quotes are written into a buffer of their
 * own first, because they are rewritten once they close (`[text](url)`, `| a | b |`, `> …`).
 */
class Writer {
  private readonly buffers: string[][] = [[]];
  /** The raw text of the current text node: a chunk can end inside an entity. */
  private pendingText = "";

  /** Page text. `verbatim` (inside <pre>) keeps its whitespace. */
  text(raw: string, lastInNode: boolean, verbatim: boolean): void {
    this.pendingText += raw;
    if (!lastInNode) return;
    const decoded = decodeEntities(this.pendingText);
    this.pendingText = "";
    this.write(verbatim ? decoded : decoded.replace(/\s+/g, " "));
  }

  write(markdown: string): void {
    this.buffers[this.buffers.length - 1]?.push(markdown);
  }

  /** Ends a paragraph. Repeated breaks are collapsed by `tidy`. */
  paragraph(): void {
    this.write("\n\n");
  }

  line(): void {
    this.write("\n");
  }

  /** Starts a buffer; `close` returns its text and drops it. */
  open(): void {
    this.buffers.push([]);
  }

  close(): string {
    if (this.buffers.length <= 1) return "";
    return (this.buffers.pop() ?? []).join("");
  }

  finish(): string {
    return tidy(this.buffers.map((buffer) => buffer.join("")).join(""));
  }
}

/** Collapses blank runs and trims lines, keeping list indentation and code blocks as they are. */
function tidy(markdown: string): string {
  let inCode = false;
  const lines = markdown.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) {
      inCode = !inCode;
      return line.trim();
    }
    if (inCode) return line.trimEnd();
    const item = /^(\s*)([-*]|\d+\.) (.*)$/.exec(line);
    if (item) return `${item[1]}${item[2]} ${(item[3] ?? "").replace(/[ \t]+/g, " ").trim()}`;
    return line.replace(/[ \t]+/g, " ").trim();
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Table {
  rows: string[][];
  row?: string[];
}

function renderTable(table: Table): string {
  const rows = table.rows.filter((row) => row.some((value) => value !== ""));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  // One column or one row means the table lays the page out: its cells are paragraphs.
  if (width === 1 || rows.length === 1) {
    return rows.flatMap((row) => row.filter((value) => value !== "")).join("\n\n");
  }
  const line = (row: string[]): string =>
    `| ${[...row, ...Array<string>(width - row.length).fill("")].join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(Array<string>(width).fill("---")), ...body.map(line)].join("\n");
}

// ---- pass 2: the rules ----

interface Context {
  out: Writer;
  ends: EndTags;
  /** Relative links resolve against this. */
  base: string;
  lists: { ordered: boolean; next: number }[];
  tables: Table[];
  /** Inside <pre>: text verbatim, no inline markup. */
  pre: number;
  /** Inside a link: nested links are text. */
  links: number;
}

type Rule = (element: HTMLRewriterTypes.Element, context: Context) => void;

/** A block element: a paragraph break before and after. */
const block: Rule = (element, { out, ends }) => {
  out.paragraph();
  ends.onClose(element, () => out.paragraph());
};

const heading: Rule = (element, { out, ends }) => {
  out.paragraph();
  out.write(`${"#".repeat(Number(element.tagName[1]))} `);
  ends.onClose(element, () => out.paragraph());
};

const list: Rule = (element, { out, ends, lists }) => {
  const start = Number.parseInt(element.getAttribute("start") ?? "1", 10);
  lists.push({ ordered: element.tagName === "ol", next: Number.isNaN(start) ? 1 : start });
  if (lists.length === 1) out.paragraph();
  ends.onClose(element, () => {
    lists.pop();
    if (lists.length === 0) out.paragraph();
  });
};

const listItem: Rule = (_element, { out, lists }) => {
  const current = lists[lists.length - 1];
  const marker = current?.ordered ? `${current.next++}.` : "-";
  out.line();
  out.write(`${"  ".repeat(Math.max(0, lists.length - 1))}${marker} `);
};

const preformatted: Rule = (element, context) => {
  const { out, ends } = context;
  const language = /language-([\w+-]+)/.exec(element.getAttribute("class") ?? "")?.[1] ?? "";
  out.paragraph();
  out.write(`\`\`\`${language}\n`);
  context.pre++;
  ends.onClose(element, () => {
    context.pre--;
    out.write("\n```");
    out.paragraph();
  });
};

const inlineCode: Rule = (element, { out, ends, pre }) => {
  if (pre > 0) return;
  out.write("`");
  ends.onClose(element, () => out.write("`"));
};

const link: Rule = (element, context) => {
  const { out, ends, base } = context;
  if (context.pre > 0 || context.links > 0) return;
  const href = decodeEntities(element.getAttribute("href") ?? "");
  // A link within the page says nothing in a file of text.
  const url = href.startsWith("#") ? undefined : absoluteUrl(href, base);
  if (!url) return;
  context.links++;
  out.open();
  ends.onClose(element, () => {
    context.links--;
    const text = out.close().replace(/\s+/g, " ").trim();
    if (text) out.write(`[${text}](${url})`);
  });
};

const image: Rule = (element, { out, base }) => {
  const alt = plainText(element.getAttribute("alt") ?? "");
  const src = absoluteUrl(decodeEntities(element.getAttribute("src") ?? ""), base);
  if (alt && src) out.write(`![${alt}](${src})`);
};

const quote: Rule = (element, { out, ends }) => {
  out.paragraph();
  out.open();
  ends.onClose(element, () => {
    const lines = tidy(out.close()).split("\n");
    out.write(lines.map((line) => `> ${line}`.trimEnd()).join("\n"));
    out.paragraph();
  });
};

const table: Rule = (element, { out, ends, tables }) => {
  const current: Table = { rows: [] };
  tables.push(current);
  out.paragraph();
  ends.onClose(element, () => {
    tables.pop();
    out.write(renderTable(current));
    out.paragraph();
  });
};

const tableRow: Rule = (element, { ends, tables }) => {
  const current = tables[tables.length - 1];
  if (!current) return;
  const row: string[] = [];
  current.row = row;
  ends.onClose(element, () => {
    current.rows.push(row);
    if (current.row === row) delete current.row;
  });
};

const tableCell: Rule = (element, { out, ends, tables }) => {
  const current = tables[tables.length - 1];
  if (!current) return;
  // A cell outside a <tr> (the parser allows it) starts a row of its own.
  if (!current.row) {
    current.row = [];
    current.rows.push(current.row);
  }
  const row = current.row;
  out.open();
  ends.onClose(element, () => {
    row.push(tidy(out.close()).replace(/\s+/g, " ").replace(/\|/g, "\\|"));
  });
};

const RULES: Record<string, Rule> = {
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading,
  p: block,
  div: block,
  section: block,
  article: block,
  main: block,
  header: block,
  figure: block,
  figcaption: block,
  address: block,
  details: block,
  summary: block,
  dl: block,
  dt: block,
  center: block,
  dd: (_element, { out }) => out.line(),
  br: (_element, { out }) => out.line(),
  hr: (_element, { out }) => {
    out.paragraph();
    out.write("---");
    out.paragraph();
  },
  ul: list,
  ol: list,
  li: listItem,
  pre: preformatted,
  code: inlineCode,
  a: link,
  img: image,
  blockquote: quote,
  table,
  tr: tableRow,
  td: tableCell,
  th: tableCell,
};

/** Converts a page; `pageUrl` is where it was fetched from, for resolving its links. */
export function htmlToMarkdown(html: string, pageUrl: string): Markdown {
  const page = scan(html);
  const ends = new EndTags();
  const context: Context = {
    out: new Writer(),
    ends,
    base: (page.base && absoluteUrl(page.base, pageUrl)) ?? pageUrl,
    lists: [],
    tables: [],
    pre: 0,
    links: 0,
  };
  let hidden = 0;
  let inRoot = page.root ? 0 : 1;
  let rootSeen = false;

  // The order matters: the root and hidden counters are updated before the rules look at them.
  const rewriter = new HTMLRewriter()
    .on(page.root === "article" ? "article" : MAIN, {
      element(element) {
        if (!page.root || rootSeen) return;
        rootSeen = true;
        if (ends.onClose(element, () => inRoot--)) inRoot++;
      },
    })
    .on(HIDDEN, {
      element(element) {
        if (ends.onClose(element, () => hidden--)) hidden++;
      },
    })
    .on("*", {
      element(element) {
        if (hidden > 0 || inRoot === 0) return;
        RULES[element.tagName]?.(element, context);
      },
    })
    .onDocument({
      text(chunk) {
        if (hidden > 0 || inRoot === 0) return;
        context.out.text(chunk.text, chunk.lastInTextNode, context.pre > 0);
      },
    });
  ends.attach(rewriter).transform(html);

  const result: Markdown = { markdown: context.out.finish() };
  if (page.title !== undefined) result.title = page.title;
  if (page.description !== undefined) result.description = page.description;
  return result;
}
