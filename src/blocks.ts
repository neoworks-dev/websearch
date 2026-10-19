// Recognizes the pages bot protection serves instead of the page that was asked for. Only the
// name of what blocked us is wanted: it tells the agent to try another source instead of
// reading a challenge page, and tells a person which protection it was.

/** Statuses a block usually comes with. */
export const BLOCK_STATUSES = new Set([401, 403, 407, 429, 503]);

/** Marks of known protections, most specific first: [what it is, a pattern in its page]. */
const SIGNATURES: [string, RegExp][] = [
  ["a Cloudflare challenge", /cf-chl-|challenge-platform|<title>Just a moment\.\.\.<\/title>/i],
  ["a Cloudflare block", /Attention Required! \| Cloudflare|cf-error-details/i],
  ["DataDome bot protection", /captcha-delivery\.com|datadome/i],
  ["HUMAN (PerimeterX) bot protection", /px-captcha|_pxAppId|perimeterx/i],
  ["Akamai bot protection", /errors\.edgesuite\.net|_abck|bm-verify/i],
  ["AWS WAF", /awswaf|aws-waf-token/i],
  ["an Anubis proof-of-work check", /anubis/i],
  ["a captcha", /g-recaptcha|h-captcha|hcaptcha\.com|cf-turnstile|captcha/i],
  // A form that a script fills with a computed answer and submits (Reddit's check is one).
  ["a JavaScript challenge", /<input[^>]+name=["']?(solution|js_challenge|jschl)/i],
];

/** How far into a page to look; challenge pages are small and say what they are early. */
const HEAD = 100_000;

/** What blocked us, if the page is a known kind of block page. */
export function blockedBy(html: string): string | undefined {
  const head = html.slice(0, HEAD);
  return SIGNATURES.find(([, pattern]) => pattern.test(head))?.[0];
}
