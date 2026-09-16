export interface BlockInput {
  status: number;
  title: string;
  html: string;
  headers: Record<string, string>;
  elementCount: number;
}

const CHALLENGE_TITLE =
  /just a moment|attention required|access denied|access to this page has been denied|are you a robot|verify you are (a )?human|please verify you are a human|pardon our interruption|request unsuccessful|security check|one more step|checking your browser/i;

const CHALLENGE_MARKUP = /cf-chl-|\/cdn-cgi\/challenge-platform\/|captcha-delivery\.com|px-captcha|_Incapsula_Resource|perimeterx\.net|_pxAppId|ak-challenge|sec-cpt/i;

const CAPTCHA = /hcaptcha|recaptcha|turnstile/i;

/**
 * Spec 8.9. Returns why the page looks like a bot wall, or null. Markers alone are not enough: some sites load
 * challenge scripts on normal pages (medium.com), so markup only counts on a failed or nearly empty page.
 */
export function detectBlock({ status, title, html, headers, elementCount }: BlockInput): string | null {
  const mitigated = Object.entries(headers).find(([name]) => name.toLowerCase() === "cf-mitigated")?.[1];
  if (mitigated?.trim().toLowerCase() === "challenge") return "cloudflare-challenge";
  if (CHALLENGE_TITLE.test(title)) return "challenge-title";
  if ((status >= 400 || elementCount < 60) && CHALLENGE_MARKUP.test(html)) return "challenge-markup";
  if (elementCount < 80 && CAPTCHA.test(html)) return "captcha-only-page";
  if ((status === 403 || status === 429 || status === 503) && elementCount < 300) return `http-${status}`;
  return null;
}
