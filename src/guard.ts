// Keeps a fetch that an agent asked for off the user's own network: localhost, the router, cloud
// metadata (169.254.169.254) and other private ranges. Checked before the request and again on
// every redirect. The name is resolved here and again by fetch, so a DNS answer that changes in
// between (rebinding) is not caught.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class PrivateAddressError extends Error {
  override name = "PrivateAddressError";
}

/** [first address, prefix length] of the IPv4 ranges that are not the public internet. */
const PRIVATE_V4: [number, number][] = [
  [v4("0.0.0.0"), 8],
  [v4("10.0.0.0"), 8],
  [v4("100.64.0.0"), 10], // carrier-grade NAT
  [v4("127.0.0.0"), 8],
  [v4("169.254.0.0"), 16], // link-local, cloud metadata
  [v4("172.16.0.0"), 12],
  [v4("192.0.0.0"), 24],
  [v4("192.0.2.0"), 24],
  [v4("192.168.0.0"), 16],
  [v4("198.18.0.0"), 15],
  [v4("198.51.100.0"), 24],
  [v4("203.0.113.0"), 24],
  [v4("224.0.0.0"), 3], // multicast, reserved, broadcast
];

function v4(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function inRange(value: number, [first, bits]: [number, number]): boolean {
  const size = 2 ** (32 - bits);
  return value >= first && value < first + size;
}

/** The eight 16-bit groups of an IPv6 address, an embedded IPv4 tail included. */
function v6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().split("%")[0] ?? "";
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail?.[1]) {
    const value = v4(tail[1]);
    text = `${text.slice(0, -tail[1].length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head.split(":").filter((group) => group !== "");
  const right = (rest ?? "").split(":").filter((group) => group !== "");
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 0) return undefined;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !PRIVATE_V4.some((range) => inRange(v4(address), range));
  if (family !== 6) return false;
  const groups = v6Groups(address);
  if (!groups || groups.some((group) => Number.isNaN(group))) return false;
  const [a = 0, b = 0] = groups;
  const embedded = (groups[6] ?? 0) * 65536 + (groups[7] ?? 0);
  const embeddedPublic = !PRIVATE_V4.some((range) => inRange(embedded, range));
  if (groups.slice(0, 5).every((group) => group === 0)) {
    // ::, ::1, and ::ffff:a.b.c.d (IPv4-mapped) are judged by their IPv4 part.
    return groups[5] === 0xffff && embeddedPublic;
  }
  if (a === 0x64 && b === 0xff9b) return embeddedPublic; // NAT64
  if (a === 0x2002)
    return !PRIVATE_V4.some((range) => inRange(b * 65536 + (groups[2] ?? 0), range));
  if ((a & 0xfe00) === 0xfc00) return false; // unique local
  if ((a & 0xffc0) === 0xfe80) return false; // link-local
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x0100 && groups.slice(1, 4).every((group) => group === 0)) return false; // discard
  return true;
}

/** Throws unless `url` is http(s) and its host resolves to public addresses only. */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PrivateAddressError(`Only http and https pages are fetched, not ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new PrivateAddressError(`${url.hostname} is on a private network (${address})`);
    }
  }
}
