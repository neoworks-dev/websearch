import { describe, expect, test } from "bun:test";
import {
  fetchPage,
  FetchPageError,
  isPublicAddress,
  type Fetch,
  type FetchPageErrorCode,
} from "../src/index.ts";
import { rejection } from "./support.ts";

describe("isPublicAddress", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
    "2002:c0a8:0101::1",
    "not an address",
  ])("%s is private", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  test.each(["1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "%s is public",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

/** Serves pages by URL; a string is HTML, a Response is sent as it is. */
function site(pages: Record<string, string | Response>): Fetch & { asked: string[] } {
  const asked: string[] = [];
  const fake = (url: string): Promise<Response> => {
    asked.push(url);
    const page = pages[url];
    if (page === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
    if (typeof page !== "string") return Promise.resolve(page);
    return Promise.resolve(
      new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
    );
  };
  return Object.assign(fake, { asked });
}

/** The code of the `FetchPageError` that `promise` rejects with; fails on any other error. */
async function failure(promise: Promise<unknown>): Promise<FetchPageErrorCode> {
  const error = await rejection(promise);
  if (!(error instanceof FetchPageError)) throw error;
  return error.code;
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } });
}

describe("fetchPage", () => {
  test("HTML becomes markdown, with the title", async () => {
    const page = await fetchPage("https://1.1.1.1/", {
      fetch: site({ "https://1.1.1.1/": "<title>Hi</title><h1>Hello</h1><p>World</p>" }),
    });
    expect(page).toMatchObject({
      title: "Hi",
      content: "# Hello\n\nWorld",
      status: 200,
      truncated: false,
    });
  });

  test("private addresses are refused before anything is sent", async () => {
    const fetch = site({});
    for (const url of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      expect(await failure(fetchPage(url, { fetch }))).toBe("private-address");
    }
    expect(fetch.asked).toEqual([]);
  });

  test("a redirect into the private network is refused", async () => {
    const fetch = site({ "https://1.1.1.1/": redirect("http://192.168.0.1/admin") });
    expect(await failure(fetchPage("https://1.1.1.1/", { fetch }))).toBe("private-address");
    expect(fetch.asked).toEqual(["https://1.1.1.1/"]);
  });

  test("redirects are followed, and the page says where it ended", async () => {
    const fetch = site({
      "https://1.1.1.1/a": redirect("/b"),
      "https://1.1.1.1/b": "<p>B</p>",
    });
    const page = await fetchPage("https://1.1.1.1/a", { fetch });
    expect(page).toMatchObject({
      url: "https://1.1.1.1/a",
      finalUrl: "https://1.1.1.1/b",
      content: "B",
    });
  });

  test("text that isn't HTML comes back as it is", async () => {
    const fetch = site({
      "https://1.1.1.1/data.json": new Response('{"a":1}', {
        headers: { "content-type": "application/json" },
      }),
    });
    expect((await fetchPage("https://1.1.1.1/data.json", { fetch })).content).toBe('{"a":1}');
  });

  test("the body is cut at maxBytes", async () => {
    const fetch = site({
      "https://1.1.1.1/": new Response("x".repeat(1000), {
        headers: { "content-type": "text/plain" },
      }),
    });
    const page = await fetchPage("https://1.1.1.1/", { fetch, maxBytes: 100 });
    expect(page).toMatchObject({ bytes: 100, truncated: true, content: "x".repeat(100) });
  });

  test("the charset comes from the header, else from the page", async () => {
    const latin1 = new Uint8Array([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9]); // <p>café
    const withMeta = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="windows-1252">'),
      ...latin1,
    ]);
    const fetch = site({
      "https://1.1.1.1/header": new Response(latin1, {
        headers: { "content-type": "text/html; charset=iso-8859-1" },
      }),
      "https://1.1.1.1/meta": new Response(withMeta, { headers: { "content-type": "text/html" } }),
    });
    expect((await fetchPage("https://1.1.1.1/header", { fetch })).content).toBe("café");
    expect((await fetchPage("https://1.1.1.1/meta", { fetch })).content).toBe("café");
  });
});

describe("fetchPage: no page at all", () => {
  test.each<[string, FetchPageErrorCode, string, Fetch?]>([
    ["not a URL", "unsupported-url", "not a url"],
    ["not http", "unsupported-url", "file:///etc/passwd"],
    ["a name that doesn't resolve", "unreachable", "https://does-not-exist.invalid/"],
    [
      "a refused connection",
      "unreachable",
      "https://1.1.1.1/",
      () => Promise.reject(new TypeError("Connection refused")),
    ],
    [
      "too many redirects",
      "too-many-redirects",
      "https://1.1.1.1/",
      site({ "https://1.1.1.1/": redirect("/") }),
    ],
    [
      "a PDF",
      "not-text",
      "https://1.1.1.1/file.pdf",
      site({
        "https://1.1.1.1/file.pdf": new Response("%PDF", {
          headers: { "content-type": "application/pdf" },
        }),
      }),
    ],
  ])("%s: %s", async (_case, code, url, fetch = site({})) => {
    expect(await failure(fetchPage(url, { fetch, maxRedirects: 3 }))).toBe(code);
  });

  test("no answer in time: timeout", async () => {
    const hang: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    expect(await failure(fetchPage("https://1.1.1.1/", { fetch: hang, timeoutMs: 20 }))).toBe(
      "timeout",
    );
  });
});

describe("fetchPage: a page that can't be read as it is", () => {
  const prose = `<p>${"Plenty of words in an ordinary paragraph of text. ".repeat(40)}</p>`;

  async function problemOf(response: Response): Promise<unknown> {
    const page = await fetchPage("https://1.1.1.1/", {
      fetch: site({ "https://1.1.1.1/": response }),
    });
    return page.problem;
  }

  function html(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "content-type": "text/html" } });
  }

  test("bot protection is named", async () => {
    expect(
      await problemOf(html("<title>Just a moment...</title><div id=cf-chl-widget></div>", 403)),
    ).toEqual({ kind: "blocked", detail: "a Cloudflare challenge (HTTP 403)" });
    // Reddit's check: a 200 with a form that a script answers.
    expect(
      await problemOf(
        html(
          '<title>Reddit</title><form hidden><input type="hidden" name="solution" /></form><script>…</script>',
        ),
      ),
    ).toEqual({ kind: "blocked", detail: "a JavaScript challenge" });
    expect(await problemOf(html("Too many requests", 429))).toEqual({
      kind: "blocked",
      detail: "rate limited (HTTP 429)",
    });
  });

  test("an error status that isn't a block", async () => {
    expect(await problemOf(html("<h1>Not found</h1>", 404))).toEqual({
      kind: "http-error",
      detail: "HTTP 404",
    });
  });

  test("a shell that scripts fill in", async () => {
    expect(await problemOf(html('<div id="root"></div><script src="/app.js"></script>'))).toEqual({
      kind: "needs-javascript",
      detail: "0 words of text without JavaScript",
    });
  });

  test("a short page without scripts, or an article with a captcha on its form, is fine", async () => {
    expect(
      await problemOf(html("<h1>Example Domain</h1><p>For use in examples.</p>")),
    ).toBeUndefined();
    // A short news item (technode.com) with a captcha on its comment form.
    const article = `<h1>News</h1><p>${"A short news item. ".repeat(25)}</p>`;
    expect(
      await problemOf(html(`${article}<form><div class="g-recaptcha"></div></form>`)),
    ).toBeUndefined();
  });

  test("content in <noscript> is used when the page has none outside it", async () => {
    // How Discourse forums serve a topic to clients without JavaScript.
    const page = await fetchPage("https://1.1.1.1/", {
      fetch: site({
        "https://1.1.1.1/": `<script src="/app.js"></script><noscript><h1>The topic</h1>${prose}</noscript>`,
      }),
    });
    expect(page.problem).toBeUndefined();
    expect(page.content).toStartWith("# The topic");
  });
});
