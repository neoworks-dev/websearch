import { describe, expect, test } from "bun:test";
import { fetchPage, isPublicAddress, type Fetch } from "../src/index.ts";
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
      expect((await rejection(fetchPage(url, { fetch }))).message).toContain("private network");
    }
    expect((await rejection(fetchPage("file:///etc/passwd", { fetch }))).message).toContain(
      "http and https",
    );
    expect(fetch.asked).toEqual([]);
  });

  test("a redirect into the private network is refused", async () => {
    const fetch = site({ "https://1.1.1.1/": redirect("http://192.168.0.1/admin") });
    expect((await rejection(fetchPage("https://1.1.1.1/", { fetch }))).message).toContain(
      "private network",
    );
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

  test("too many redirects", async () => {
    const fetch = site({ "https://1.1.1.1/": redirect("/") });
    const error = await rejection(fetchPage("https://1.1.1.1/", { fetch, maxRedirects: 3 }));
    expect(error.message).toContain("redirects");
  });

  test("text that isn't HTML comes back as it is; binary content is refused", async () => {
    const fetch = site({
      "https://1.1.1.1/data.json": new Response('{"a":1}', {
        headers: { "content-type": "application/json" },
      }),
      "https://1.1.1.1/file.pdf": new Response("%PDF", {
        headers: { "content-type": "application/pdf" },
      }),
    });
    expect((await fetchPage("https://1.1.1.1/data.json", { fetch })).content).toBe('{"a":1}');
    const error = await rejection(fetchPage("https://1.1.1.1/file.pdf", { fetch }));
    expect(error.message).toContain("not a text page");
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
