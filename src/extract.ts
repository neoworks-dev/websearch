// Reads a results page with Bun's HTMLRewriter: CSS selectors over a stream, no DOM. An engine
// says where its results are (`ResultSelectors`); this walks the page once and collects them.
import { EndTags } from "./end-tags.ts";
import { decodeEntities, plainText } from "./entities.ts";

/**
 * One value of a result: an attribute of the first element matching `selector`, or, without
 * `attribute`, that element's text.
 */
export interface Field {
  selector: string;
  attribute?: string;
}

/**
 * Where a page's results are, as CSS selectors. HTMLRewriter supports type, class, id and
 * attribute selectors and the descendant and child combinators, not `:has()` or sibling ones.
 * A field's selector may be the result's own, to read an attribute of the result element.
 */
export interface ResultSelectors {
  /** Each match starts a result. */
  result: string;
  /** The URL: the href of the first match (a string), or any field. */
  link?: string | Field;
  /** The text of the first match (a string), or any field. */
  title?: string | Field;
  snippet?: string | Field;
  /** More values, such as a date or a source, under names of the engine's choosing. */
  fields?: Record<string, Field>;
  /**
   * The fields come after the result's element instead of inside it, up to the next result.
   * DuckDuckGo Lite needs this: the link and the snippet are separate rows of one table.
   */
  following?: boolean;
}

/** A result as the page has it: values decoded and trimmed, the URL not yet resolved. */
export interface RawHit {
  href: string;
  title: string;
  snippet: string;
  fields: Record<string, string>;
}

interface Draft {
  values: Record<string, string>;
  /** Fields whose first match was seen; later matches are ignored. */
  taken: Set<string>;
}

/** Text inside these is never page text. */
const NOT_TEXT = "script, style, noscript, template";

function asField(spec: string | Field | undefined, attribute?: string): Field | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec !== "string") return spec;
  return attribute === undefined ? { selector: spec } : { selector: spec, attribute };
}

export function extractHits(html: string, selectors: ResultSelectors): RawHit[] {
  const fields: [string, Field | undefined][] = [
    ["href", asField(selectors.link, "href")],
    ["title", asField(selectors.title)],
    ["snippet", asField(selectors.snippet)],
    ...Object.entries(selectors.fields ?? {}),
  ];
  const ends = new EndTags();
  const drafts: Draft[] = [];
  let current: Draft | undefined;
  let hidden = 0;
  // The text fields being read now, with how many of their elements are open. Text is taken
  // once at the document level: an element's own handler would see nested matches twice.
  const reading = new Map<string, number>();

  const rewriter = new HTMLRewriter().on(selectors.result, {
    element(element) {
      const draft: Draft = { values: {}, taken: new Set() };
      drafts.push(draft);
      current = draft;
      if (selectors.following) return;
      ends.onClose(element, () => {
        if (current === draft) current = undefined;
      });
    },
  });
  for (const [name, field] of fields) {
    if (!field) continue;
    rewriter.on(field.selector, {
      element(element) {
        if (!current || current.taken.has(name)) return;
        current.taken.add(name);
        if (field.attribute !== undefined) {
          current.values[name] = element.getAttribute(field.attribute) ?? "";
          return;
        }
        current.values[name] = "";
        const opened = ends.onClose(element, () => reading.set(name, (reading.get(name) ?? 1) - 1));
        if (opened) reading.set(name, (reading.get(name) ?? 0) + 1);
      },
    });
  }
  rewriter
    .on(NOT_TEXT, {
      element(element) {
        if (ends.onClose(element, () => hidden--)) hidden++;
      },
    })
    .onDocument({
      text(chunk) {
        if (!current || hidden > 0) return;
        for (const [name, open] of reading) {
          if (open > 0) current.values[name] += chunk.text;
        }
      },
    });
  ends.attach(rewriter).transform(html);

  return drafts.map(({ values }) => {
    const value = (name: string): string => plainText(values[name] ?? "");
    const extra: Record<string, string> = {};
    for (const name of Object.keys(selectors.fields ?? {})) extra[name] = value(name);
    return {
      href: decodeEntities(values.href ?? "").trim(),
      title: value("title"),
      snippet: value("snippet"),
      fields: extra,
    };
  });
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
