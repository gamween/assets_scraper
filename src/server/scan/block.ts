export interface BlockInput {
  status: number;
  title: string;
  html: string;
  headers: Record<string, string>;
  elementCount: number;
}

/**
 * The spec 8.9 title phrases that only a challenge page uses. They always count. Matched as whole words: "Security
 * CheckUp" is a product page, not "Security check".
 */
const CHALLENGE_TITLE =
  /\b(?:just a moment|attention required|access to this page has been denied|are you a robot|verify you are (a )?human|please verify you are a human|pardon our interruption|checking your browser)\b/i;

/**
 * The spec 8.9 title phrases an ordinary page can use too ("One more step to your account"). They only count on a failed
 * page (see detectChallenge) or on a small one (see detectBlock): real walls with these titles are tiny pages.
 */
const GENERIC_CHALLENGE_TITLE = /\b(?:access denied|request unsuccessful|security check|one more step)\b/i;

/** A page with fewer elements than this is small enough for a generic challenge title to count. */
const GENERIC_TITLE_MAX_ELEMENTS = 300;

const CHALLENGE_MARKUP = /cf-chl-|\/cdn-cgi\/challenge-platform\/|captcha-delivery\.com|px-captcha|_Incapsula_Resource|perimeterx\.net|_pxAppId|ak-challenge|sec-cpt/i;

const CAPTCHA = /hcaptcha|recaptcha|turnstile/i;

/**
 * The spec 8.9 rules that do not depend on how much of the page exists: the header, the specific title phrases, and the
 * generic title phrases on a failed response (status 400 or more). They hold as soon as the page has its title (spec 7.2
 * phase 4, `domcontentloaded`).
 */
export function detectChallenge({ status, title, headers }: Pick<BlockInput, "status" | "title" | "headers">): string | null {
  const mitigated = Object.entries(headers).find(([name]) => name.toLowerCase() === "cf-mitigated")?.[1];
  if (mitigated?.trim().toLowerCase() === "challenge") return "cloudflare-challenge";
  if (CHALLENGE_TITLE.test(title)) return "challenge-title";
  if (status >= 400 && GENERIC_CHALLENGE_TITLE.test(title)) return "challenge-title";
  return null;
}

/**
 * Spec 8.9, every rule. Returns why the page looks like a bot wall, or null. Markers alone are not enough: some sites
 * load challenge scripts on normal pages (medium.com), so markup only counts on a failed or nearly empty page, and a
 * generic title phrase only on a failed or small page. The rules that count elements only hold once the page has loaded
 * and gone idle, as in the lab: at `domcontentloaded` a client-rendered app is still a nearly empty shell.
 */
export function detectBlock(input: BlockInput): string | null {
  const { status, title, html, elementCount } = input;
  const challenge = detectChallenge(input);
  if (challenge) return challenge;
  if (elementCount < GENERIC_TITLE_MAX_ELEMENTS && GENERIC_CHALLENGE_TITLE.test(title)) return "challenge-title";
  if ((status >= 400 || elementCount < 60) && CHALLENGE_MARKUP.test(html)) return "challenge-markup";
  if (elementCount < 80 && CAPTCHA.test(html)) return "captcha-only-page";
  if ((status === 403 || status === 429 || status === 503) && elementCount < 300) return `http-${status}`;
  return null;
}
