// Reads a results page with Bun's HTMLRewriter: CSS selectors over a stream, no DOM. An engine
// says where its results are (`ResultSelectors`); this walks the page once and collects them.
import { EndTags } from "./end-tags.ts";
import { decodeEntities, plainText } from "./entities.ts";

/**
 * Where a page's results are, as CSS selectors. HTMLRewriter supports type, class, id and
 * attribute selectors and the descendant and child combinators, not `:has()` or sibling ones.
 */
export interface ResultSelectors {
  /** Each match starts a result. */
  result: string;
  /** The result's URL: the href of the first match. */
  link: string;
  /** The text of the first match. */
  title: string;
  /** The text of the first match. */
  snippet: string;
  /**
   * The fields come after the result's element instead of inside it, up to the next result.
   * DuckDuckGo Lite needs this: the link and the snippet are separate rows of one table.
   */
  following?: boolean;
}

/** A result as the page has it, its href not yet resolved or unwrapped. */
export interface RawHit {
  href: string;
  title: string;
  snippet: string;
}

interface Draft {
  href?: string;
  title: string;
  snippet: string;
  hasTitle: boolean;
  hasSnippet: boolean;
}

/** Text inside these is never page text. */
const NOT_TEXT = "script, style, noscript, template";

export function extractHits(html: string, selectors: ResultSelectors): RawHit[] {
  const ends = new EndTags();
  const drafts: Draft[] = [];
  let current: Draft | undefined;
  // Counters of open elements. Text is taken once, at the document level, because an
  // element's own text handler would see the text of nested matches a second time.
  let hidden = 0;
  let inTitle = 0;
  let inSnippet = 0;

  const rewriter = new HTMLRewriter()
    .on(selectors.result, {
      element(element) {
        const draft: Draft = { title: "", snippet: "", hasTitle: false, hasSnippet: false };
        drafts.push(draft);
        current = draft;
        if (selectors.following) return;
        ends.onClose(element, () => {
          if (current === draft) current = undefined;
        });
      },
    })
    .on(selectors.link, {
      element(element) {
        if (current && current.href === undefined) {
          current.href = decodeEntities(element.getAttribute("href") ?? "");
        }
      },
    })
    .on(selectors.title, {
      element(element) {
        if (!current || current.hasTitle) return;
        current.hasTitle = true;
        if (ends.onClose(element, () => inTitle--)) inTitle++;
      },
    })
    .on(selectors.snippet, {
      element(element) {
        if (!current || current.hasSnippet) return;
        current.hasSnippet = true;
        if (ends.onClose(element, () => inSnippet--)) inSnippet++;
      },
    })
    .on(NOT_TEXT, {
      element(element) {
        if (ends.onClose(element, () => hidden--)) hidden++;
      },
    })
    .onDocument({
      text(chunk) {
        if (!current || hidden > 0) return;
        if (inTitle > 0) current.title += chunk.text;
        if (inSnippet > 0) current.snippet += chunk.text;
      },
    });
  ends.attach(rewriter).transform(html);

  const hits: RawHit[] = [];
  for (const draft of drafts) {
    if (!draft.href) continue;
    hits.push({
      href: draft.href,
      title: plainText(draft.title),
      snippet: plainText(draft.snippet),
    });
  }
  return hits;
}

/** The absolute http(s) URL an href points to; undefined for fragments, javascript:, mailto:. */
export function absoluteUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
