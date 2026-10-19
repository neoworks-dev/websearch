// What searching and fetching share: the fetch they call and the browser they say they are.

/** The `fetch` the library calls. Tests pass a fake one; a proxy can be put in front this way. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A current desktop Chrome. Search engines serve their plain HTML pages to it. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
