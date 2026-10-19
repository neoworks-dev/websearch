// Fetches one page and returns it as markdown (HTML) or as it is (text, JSON, XML).
//
// Two kinds of failure are told apart:
//   - No page at all: `fetchPage` throws a `FetchPageError` with a `code` (errors.ts).
//   - A page that can't be read as it is (a block, a shell that needs JavaScript, a 404): it is
//     returned, with a `problem` saying which, so the caller can move on to another source.
//
// Redirects are followed by hand so that every hop passes the private-network guard; the body
// is read up to a size limit; the charset comes from the header, else from the page's <meta>.
import { BLOCK_STATUSES, blockedBy } from "./blocks.ts";
import { FetchPageError } from "./errors.ts";
import { assertPublicUrl } from "./guard.ts";
import { DEFAULT_USER_AGENT, type Fetch } from "./http.ts";
import { htmlToMarkdown, type Markdown } from "./markdown.ts";

export interface FetchPageOptions {
  fetch?: Fetch;
  signal?: AbortSignal;
  /** For the whole fetch, redirects included; 20 seconds. */
  timeoutMs?: number;
  /** The body is cut here and `truncated` is set; 5 MB. */
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  /**
   * Allows localhost and private addresses. Off by default: a URL an agent picked must not
   * reach the user's router, other machines on the network, or a cloud metadata endpoint.
   */
  allowPrivateNetwork?: boolean;
}

export interface Page {
  /** As asked for. */
  url: string;
  /** After redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  description?: string;
  /** Markdown for HTML; the text as it is for other text types. */
  content: string;
  /** Bytes read, at most `maxBytes`. */
  bytes: number;
  truncated: boolean;
  /** Set when the page loaded but isn't the content that was asked for. */
  problem?: PageProblem;
}

export interface PageProblem {
  /**
   * - `blocked`: bot protection answered instead of the site (`detail` names it);
   * - `needs-javascript`: the HTML is a shell that scripts fill in;
   * - `http-error`: the site answered with an error status (404, 500, …).
   */
  kind: "blocked" | "needs-javascript" | "http-error";
  /** What was seen, for a person or an agent: "a Cloudflare challenge (HTTP 403)", "HTTP 404". */
  detail: string;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|ld\+json)|[^;]*\+(json|xml))/;

/** A page with fewer words than this has almost no text of its own. */
const THIN_WORDS = 50;

/**
 * Block pages are short: the ones seen were 1 to 6 words. A longer page that mentions a captcha
 * has one on its comment form (a 145-word news item did). Under an error status, a page of up
 * to this many words with a protection's marks is that protection's block page.
 */
const BLOCK_PAGE_WORDS = 300;

/**
 * Fetches `url` and converts it. Throws a `FetchPageError` when there is no page (see its
 * `code`); returns a page with a `problem` when there is one that can't be read as it is.
 */
export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<Page> {
  const { response, finalUrl, bytes, truncated } = await download(url, options);

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const mime = contentType.split(";")[0]?.trim() ?? "";
  const text = decode(bytes, contentType);
  const isHtml =
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    (mime === "" && /^\s*(<!doctype html|<html)/i.test(text));
  if (!isHtml && !TEXT_TYPES.test(mime)) {
    throw new FetchPageError(
      "not-text",
      `${finalUrl} is ${mime || "of an unknown type"}, not text`,
    );
  }

  const page: Page = {
    url,
    finalUrl,
    status: response.status,
    contentType,
    content: text,
    bytes: bytes.length,
    truncated,
  };
  if (isHtml) {
    const { markdown, title, description } = convert(text, finalUrl);
    page.content = markdown;
    if (title !== undefined) page.title = title;
    if (description !== undefined) page.description = description;
  }
  const problem = diagnose(page.status, isHtml ? text : undefined, page.content);
  if (problem) page.problem = problem;
  return page;
}

/** The response and its body, or a `FetchPageError` saying why there is none. */
async function download(
  url: string,
  options: FetchPageOptions,
): Promise<{ response: Response; finalUrl: string; bytes: Uint8Array; truncated: boolean }> {
  let start: URL;
  try {
    start = new URL(url);
  } catch {
    throw new FetchPageError("unsupported-url", `${url} isn't a URL`);
  }
  const timeoutMs = options.timeoutMs ?? 20_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const { response, finalUrl } = await follow(start, options, signal);
    const body = await readBody(response, options.maxBytes ?? 5_000_000);
    return { response, finalUrl, ...body };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof FetchPageError) throw error;
    if (timeout.aborted) {
      throw new FetchPageError("timeout", `${start.host} didn't answer within ${timeoutMs} ms`, {
        cause: error,
      });
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new FetchPageError("unreachable", `${start.host}: ${reason}`, { cause: error });
  }
}

/** The page as markdown; its <noscript> content when that is where the text is. */
function convert(html: string, url: string): Markdown {
  const converted = htmlToMarkdown(html, url);
  if (words(converted.markdown) >= THIN_WORDS || !/<noscript\b/i.test(html)) return converted;
  // Some sites put their content in <noscript> for clients without JavaScript; Discourse
  // forums do. Without its tags, the content is parsed as part of the page.
  const unwrapped = htmlToMarkdown(html.replace(/<\/?noscript\b[^>]*>/gi, ""), url);
  return words(unwrapped.markdown) > words(converted.markdown) ? unwrapped : converted;
}

/** What is wrong with a page that loaded, if anything. `html` is undefined for other text. */
function diagnose(
  status: number,
  html: string | undefined,
  content: string,
): PageProblem | undefined {
  const count = words(content);
  const protection = html === undefined ? undefined : blockedBy(html);
  if (status >= 400) {
    if (protection && (BLOCK_STATUSES.has(status) || count < BLOCK_PAGE_WORDS)) {
      return { kind: "blocked", detail: `${protection} (HTTP ${status})` };
    }
    if (status === 429) return { kind: "blocked", detail: "rate limited (HTTP 429)" };
    return { kind: "http-error", detail: `HTTP ${status}` };
  }
  // With a 200, only a page with next to no text of its own is a block page.
  if (protection && count < THIN_WORDS) return { kind: "blocked", detail: protection };
  if (html !== undefined && count < THIN_WORDS && /<script\b/i.test(html)) {
    return { kind: "needs-javascript", detail: `${count} words of text without JavaScript` };
  }
  return undefined;
}

function words(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

/** The response after redirects, and where they ended. */
async function follow(
  start: URL,
  options: FetchPageOptions,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects = options.maxRedirects ?? 5;
  let current = start;
  for (let hop = 0; ; hop++) {
    if (!options.allowPrivateNetwork) await assertPublicUrl(current);
    const response = await (options.fetch ?? fetch)(current.href, {
      headers: {
        "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "manual",
      signal,
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, finalUrl: current.href };
    }
    await response.body?.cancel();
    if (hop >= maxRedirects) {
      throw new FetchPageError("too-many-redirects", `More than ${maxRedirects} redirects`);
    }
    current = new URL(location, current);
  }
}

async function readBody(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(chunks, size), truncated: false };
    if (size + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      await reader.cancel();
      return { bytes: Buffer.concat(chunks, maxBytes), truncated: true };
    }
    chunks.push(value);
    size += value.length;
  }
}

/** Decodes with the charset the header names, else the page's <meta>, else UTF-8. */
function decode(bytes: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(charset(bytes, contentType)).decode(bytes);
  } catch {
    // A charset TextDecoder doesn't know.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function charset(bytes: Uint8Array, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  // The first kilobytes read as Latin-1 can be searched for <meta charset> whatever the encoding.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  if (fromMeta) return fromMeta;
  return "utf-8";
}
