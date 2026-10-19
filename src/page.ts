// Fetches one page and returns it as markdown (HTML) or as it is (text, JSON, XML). Redirects are
// followed by hand so that every hop passes the private-network guard; the body is read up to a
// size limit; the charset comes from the header, else from the page's <meta>.
import { assertPublicUrl } from "./guard.ts";
import { htmlToMarkdown } from "./markdown.ts";
import { DEFAULT_USER_AGENT, type Fetch } from "./http.ts";

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
}

export class FetchPageError extends Error {
  override name = "FetchPageError";
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|ld\+json)|[^;]*\+(json|xml))/;

/** Fetches `url` and converts it. Throws for non-text content and private addresses. */
export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<Page> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const { response, finalUrl } = await follow(new URL(url), options, signal);

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const mime = contentType.split(";")[0]?.trim() ?? "";
  const { bytes, truncated } = await readBody(response, options.maxBytes ?? 5_000_000);
  const text = decode(bytes, contentType);
  const html =
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    (mime === "" && /^\s*(<!doctype html|<html)/i.test(text));
  if (!html && !TEXT_TYPES.test(mime)) {
    throw new FetchPageError(`${finalUrl} is ${mime || "of an unknown type"}, not a text page`);
  }

  const page = {
    url,
    finalUrl,
    status: response.status,
    contentType,
    bytes: bytes.length,
    truncated,
  };
  if (!html) return { ...page, content: text };
  const { markdown, ...meta } = htmlToMarkdown(text, finalUrl);
  return { ...page, ...meta, content: markdown };
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
    if (hop >= maxRedirects) throw new FetchPageError(`More than ${maxRedirects} redirects`);
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
