import type { HiddenReason } from "@/lib/contract";
import type { RawSvg } from "../types";

/** Noise rules (spec 8.2), ported from the discovery lab (`lib/noise.mjs`). Entries are `host` or `host/path-prefix`. */
const TRACKER_HOSTS = [
  "google-analytics.com", "googletagmanager.com", "doubleclick.net", "googleadservices.com", "googlesyndication.com", "adservice.google.com",
  "facebook.com", "facebook.net", "bat.bing.com", "clarity.ms", "px.ads.linkedin.com", "snap.licdn.com", "analytics.twitter.com", "t.co",
  "ads-twitter.com", "ct.pinterest.com", "analytics.tiktok.com", "sc-static.net", "tr.snapchat.com", "alb.reddit.com", "hotjar.com", "hotjar.io",
  "segment.io", "segment.com", "mixpanel.com", "amplitude.com", "heapanalytics.com", "fullstory.com", "mc.yandex.ru", "scorecardresearch.com",
  "quantserve.com", "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com", "rlcdn.com", "demdex.net", "omtrdc.net",
  "everesttech.net", "bluekai.com", "krxd.net", "adsrvr.org", "rubiconproject.com", "pubmatic.com", "casalemedia.com", "agkn.com", "liadm.com",
  "bidswitch.net", "mathtag.com", "tapad.com", "zemanta.com", "mktoresp.com", "marketo.net", "track.hubspot.com", "hs-analytics.net",
  "hsforms.com", "bounceexchange.com", "cquotient.com", "dotomi.com", "ads.yahoo.com", "analytics.yahoo.com",
  "sentry.io", "datadoghq.com", "browser-intake-datadoghq.com", "nr-data.net", "newrelic.com", "pardot.com", "pi.pardot.com", "qualaroo.com",
  "rs6.net", "pinimg.com/ct", "cloudflareinsights.com", "plausible.io", "usefathom.com", "posthog.com", "intercomcdn.com/tracking",
  "adroll.com", "bizible.com", "bizographics.com", "clearbit.com", "clearbitscripts.com", "g2crowd.com", "sharethis.com", "addthis.com",
  "rudderstack.com", "attn.tv", "klaviyo.com/onsite", "trustpilot.com/stats", "smartlook.com", "mouseflow.com", "crazyegg.com", "vwo.com",
  "optimizely.com", "demandbase.com", "6sc.co", "reb2b.com", "cookieyes.com/log", "tiktokw.us", "ipredictive.com", "contentsquare.net",
];
const CONSENT_HOSTS = [
  "cookielaw.org", "onetrust.com", "cookiebot.com", "privacy-mgmt.com", "usercentrics.eu", "privacy-center.org", "osano.com", "trustarc.com",
  "termly.io", "iubenda.com", "didomi.io", "consentmanager.net", "cookieyes.com", "transcend.io", "ketch.com", "truste.com",
];
const WIDGET_HOSTS = [
  "intercom.io", "intercomassets.com", "intercomcdn.com", "driftt.com", "drift.com", "zdassets.com", "zendesk.com", "crisp.chat", "tawk.to",
  "livechatinc.com", "hubspot.com/conversations", "usemessages.com", "gstatic.com/recaptcha", "hcaptcha.com", "challenges.cloudflare.com",
  "maps.googleapis.com", "maps.gstatic.com", "ytimg.com", "i.vimeocdn.com",
];

const TRACKING_PATH = /\/(?:tr|collect|pixel|beacon|track|impression|__imp|b\/ss|g\/collect|j\/collect)(?:\/|\?|$)/i;
const SPACER = /\/(?:pixel|spacer|blank|transparent|clear|1x1|trans|empty)\.(?:gif|png)$/i;
const BLANK = /\/blank\.(?:jpe?g|webp|svg)$/i;
const DRAWABLE = /<(?:path|circle|rect|ellipse|line|polyline|polygon|text|image|use)\b/i;

const listMatches = (u: URL, list: string[]) => {
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  return list.some((entry) => {
    const slash = entry.indexOf("/");
    const entryHost = slash < 0 ? entry : entry.slice(0, slash);
    if (host !== entryHost && !host.endsWith(`.${entryHost}`)) return false;
    return slash < 0 || path.startsWith(entry.slice(slash));
  });
};

/** Raster data URIs smaller than this are noise (`tiny-data-uri`), whatever their dimensions. */
export const TINY_DATA_URI_BYTES = 1024;

export interface NoiseInput {
  url: string;
  contentType?: string;     // captured or probed content type, or the media type of a data URI
  width?: number;           // decoded size
  height?: number;
  bytes?: number;
  svgText?: string;         // markup of an SVG data URI
  blobCaptured?: boolean;   // bytes exist for a blob: URL
}

/** Why an image URL is noise, or null when it is a real asset. */
export function noiseReason(input: NoiseInput): HiddenReason | null {
  const { url, width, height } = input;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not-image";
  }
  if (u.protocol === "data:") {
    if (/^data:image\/svg/i.test(url)) {
      if (input.svgText != null && !DRAWABLE.test(input.svgText)) return "placeholder";
      if (input.svgText != null && /feGaussianBlur/i.test(input.svgText) && /<image\b/i.test(input.svgText)) return "placeholder";
      return null;
    }
    const bytes = input.bytes ?? url.length * 0.75;
    if (width != null && height != null && Math.max(width, height) < 64) return "tiny-data-uri";
    return bytes < TINY_DATA_URI_BYTES ? "tiny-data-uri" : null;
  }
  if (u.protocol === "blob:") return input.blobCaptured ? null : "blob-unavailable";
  if (u.protocol !== "http:" && u.protocol !== "https:") return "not-image";
  if (listMatches(u, TRACKER_HOSTS) || (TRACKING_PATH.test(u.pathname) && width != null && width <= 2)) return "tracker";
  if (SPACER.test(u.pathname) || BLANK.test(u.pathname)) return "spacer";
  if (width != null && height != null && width <= 2 && height <= 2) return "pixel";
  const contentType = input.contentType?.trim();
  if (contentType && !/^image\//i.test(contentType) && !/octet-stream|binary/i.test(contentType)) return "not-image";
  if (listMatches(u, CONSENT_HOSTS)) return "consent";
  if (listMatches(u, WIDGET_HOSTS)) return "widget";
  return null;
}

/** Why an inline SVG is noise: visible under 6 px, or markup over the size cap. Lottie frames are dropped in the page. */
export function svgNoiseReason(svg: Pick<RawSvg, "markup" | "visible" | "rect">, maxBytes: number): HiddenReason | null {
  if (Buffer.byteLength(svg.markup) > maxBytes) return "svg-too-large";
  if (svg.visible && svg.rect && Math.max(svg.rect.width, svg.rect.height) < 6) return "tiny-svg";
  return null;
}
