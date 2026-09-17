export interface BlockInput {
  status: number;
  title: string;
  html: string;
  headers: Record<string, string>;
  elementCount: number;
}

/**
 * The spec 8.9 title phrases, matched as whole words: "Security CheckUp" is a product page, not "Security check".
 */
const CHALLENGE_TITLE =
  /\b(?:just a moment|attention required|access denied|access to this page has been denied|are you a robot|verify you are (a )?human|please verify you are a human|pardon our interruption|request unsuccessful|security check|one more step|checking your browser)\b/i;

const CHALLENGE_MARKUP = /cf-chl-|\/cdn-cgi\/challenge-platform\/|captcha-delivery\.com|px-captcha|_Incapsula_Resource|perimeterx\.net|_pxAppId|ak-challenge|sec-cpt/i;

const CAPTCHA = /hcaptcha|recaptcha|turnstile/i;

/**
 * The spec 8.9 rules that only need the response headers and the title. They hold as soon as the page has its title
 * (spec 7.2 phase 4, `domcontentloaded`).
 */
export function detectChallenge({ title, headers }: Pick<BlockInput, "title" | "headers">): string | null {
  const mitigated = Object.entries(headers).find(([name]) => name.toLowerCase() === "cf-mitigated")?.[1];
  if (mitigated?.trim().toLowerCase() === "challenge") return "cloudflare-challenge";
  if (CHALLENGE_TITLE.test(title)) return "challenge-title";
  return null;
}

/**
 * Spec 8.9, every rule. Returns why the page looks like a bot wall, or null. Markers alone are not enough: some sites
 * load challenge scripts on normal pages (medium.com), so markup only counts on a failed or nearly empty page. The
 * markup, captcha and status rules count elements, so they only hold once the page has loaded and gone idle, as in
 * the lab: at `domcontentloaded` a client-rendered app is still a nearly empty shell.
 */
export function detectBlock(input: BlockInput): string | null {
  const { status, html, elementCount } = input;
  const challenge = detectChallenge(input);
  if (challenge) return challenge;
  if ((status >= 400 || elementCount < 60) && CHALLENGE_MARKUP.test(html)) return "challenge-markup";
  if (elementCount < 80 && CAPTCHA.test(html)) return "captcha-only-page";
  if ((status === 403 || status === 429 || status === 503) && elementCount < 300) return `http-${status}`;
  return null;
}
