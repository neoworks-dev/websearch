// Why `fetchPage` got no page at all. A page that loaded but can't be read (a block, a shell
// that needs JavaScript, a 404) is not an error: it comes back with a `problem` (see page.ts).

export type FetchPageErrorCode =
  /** The URL isn't http or https. */
  | "unsupported-url"
  /** The host is on a private network: localhost, the LAN, cloud metadata. */
  | "private-address"
  /** The name doesn't resolve, the connection was refused, TLS failed. */
  | "unreachable"
  /** No complete answer within `timeoutMs`. */
  | "timeout"
  /** More redirects than `maxRedirects`. */
  | "too-many-redirects"
  /** A PDF, an image, a download: something that isn't text. */
  | "not-text";

export class FetchPageError extends Error {
  override name = "FetchPageError";

  constructor(
    readonly code: FetchPageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
