import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Asset, AssetFormat, AssetRole, FoundIn } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { MAX_HEAD_URL_CHARS, type PageHead } from "./preflight";
import type { SafeFetch, Signer } from "./types";

/** Spec 8.9: Wikidata asks for a descriptive user agent. Nothing personal goes in it. */
const PUBLIC_SOURCE_USER_AGENT = "AssetsScraper/1.0 (+https://github.com/gamween/assets_scraper)";
const FAVICON_SERVICE_MS = 3_000;
const FAVICON_MAX_BYTES = 1024 * 1024;
/**
 * The fallback travels in a single `error` line (spec 14: 256 KB). Each asset carries its URL four times (display and
 * original, each with the signed proxy path), about 10 KB at the longest URL kept, plus its name, which holds the site
 * name (at most 200 characters, see `parseHead`), so 20 assets stay well under.
 */
const MAX_FALLBACK_ASSETS = 20;
const MAX_FALLBACK_URL_CHARS = MAX_HEAD_URL_CHARS;
/** Per source, so that one crowded head (dozens of icon links) leaves room for the others. */
const MAX_HEAD_ICONS = 8;
const MAX_SOCIAL_IMAGES = 4;
const MAX_JSON_LD_LOGOS = 4;
const ROLE_WEIGHT: Partial<Record<AssetRole, number>> = { "site-logo": 1000, favicon: 300, social: 200, image: 100 };

const EXTENSION_FORMAT: Record<string, AssetFormat> = {
  svg: "svg", svgz: "svg", png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp", avif: "avif", gif: "gif", ico: "ico", cur: "ico", bmp: "bmp",
};
const TYPE_FORMAT: Record<string, AssetFormat> = {
  "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif",
  "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/bmp": "bmp",
};

const extensionOf = (url: string) => /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname)?.[1].toLowerCase();

function formatOf(url: string, contentType?: string): AssetFormat {
  const type = contentType?.split(";")[0].trim().toLowerCase() ?? "";
  return TYPE_FORMAT[type] ?? EXTENSION_FORMAT[extensionOf(url) ?? ""] ?? "other";
}

const slug = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** First DNS label without `www.`: `www.zillow.com` gives `zillow`. */
const hostLabel = (host: string) => host.toLowerCase().replace(/^www\./, "").split(".")[0] || "site";
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

interface Draft {
  url: string;
  role: AssetRole;
  foundIn: FoundIn;
  name: string;
  basename: string;
  format: AssetFormat;
  width?: number;
  height?: number;
  bytes?: number;
}

/** Turns drafts into contract assets: unique ids and filenames, scores by role and order, signed URLs. */
function toAssets(drafts: Draft[], host: string, signer: Signer): Asset[] {
  const siteSlug = slug(hostLabel(host)) || "site";
  const usedFilenames = new Set<string>();
  const seenUrls = new Set<string>();
  const assets: Asset[] = [];
  for (const draft of drafts) {
    if (seenUrls.has(draft.url)) continue;
    seenUrls.add(draft.url);
    let proxy: string;
    try {
      proxy = signer.sign(draft.url);
    } catch {
      continue;
    }
    const base = slug(draft.basename).slice(0, 60) || draft.role;
    const stem = (base === siteSlug || base.startsWith(`${siteSlug}-`) ? base : `${siteSlug}-${base}`).slice(0, 72).replace(/-+$/, "");
    const extension = draft.format === "other" ? (extensionOf(draft.url) ?? "bin") : draft.format;
    let filename = `${stem}.${extension}`;
    for (let n = 2; usedFilenames.has(filename); n += 1) filename = `${stem}-${n}.${extension}`;
    usedFilenames.add(filename);

    const order = assets.length;
    const size = { ...(draft.width && draft.height ? { width: draft.width, height: draft.height } : {}), ...(draft.bytes ? { bytes: draft.bytes } : {}) };
    const source = { url: draft.url, proxy, format: draft.format, ...size };
    assets.push({
      id: createHash("sha1").update(`${draft.foundIn}\n${draft.url}`).digest("hex"),
      kind: draft.format === "svg" ? "svg" : "image",
      role: draft.role,
      name: draft.name,
      filename,
      format: draft.format,
      foundIn: [draft.foundIn],
      visible: false,
      declaredOnly: false,
      order,
      score: (ROLE_WEIGHT[draft.role] ?? 100) - order * 0.01,
      usedCount: 1,
      ...size,
      tone: "unknown",
      display: source,
      original: source,
    });
  }
  return assets;
}

/** `100%25.pdf` gives `100%.pdf`; a malformed escape (`%zz`) keeps the segment as it is. */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The single asset of a URL that turned out to be a file, not a page (spec 7.2 phase 1, `not-html`). */
export function directAsset(input: { url: string; contentType: string; bytes?: number; signer: Signer }): Asset {
  const { url, contentType, bytes, signer } = input;
  const host = new URL(url).hostname;
  const file = decodePathSegment(new URL(url).pathname.split("/").pop() ?? "").replace(/\.[a-z0-9]{1,5}$/i, "");
  const name = file.trim() || `${capitalize(hostLabel(host))} file`;
  const format = formatOf(url, contentType);
  const [asset] = toAssets([{ url, role: "image", foundIn: "network", name, basename: name, format, bytes }], host, signer);
  if (!asset) throw new Error("The file URL could not be signed");
  return asset;
}

async function googleFavicon(host: string, fetch: SafeFetch, signal: AbortSignal): Promise<Draft | null> {
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=256`;
  const response = await fetch(url, { headers: { "user-agent": PUBLIC_SOURCE_USER_AGENT }, timeoutMs: FAVICON_SERVICE_MS, maxBytes: FAVICON_MAX_BYTES, signal });
  const contentType = response.headers.get("content-type") ?? "";
  // Google answers 404 with a generic globe when it has no icon for the host.
  if (response.status !== 200 || !contentType.startsWith("image/")) {
    await response.cancel();
    return null;
  }
  const body = await response.buffer();
  const { width, height } = await sharp(body).metadata().catch(() => ({ width: undefined, height: undefined }));
  return { url, role: "favicon", foundIn: "public-source", name: "", basename: "favicon", format: formatOf(url, contentType), width, height, bytes: body.length };
}

interface SparqlResults {
  results?: { bindings?: { logo?: { value?: string }; site?: { value?: string } }[] };
}

/** Wikidata P154 (logo image) of the item whose P856 (official website) is this host (spec 8.9). */
async function wikidataLogo(host: string, fetch: SafeFetch, signal: AbortSignal): Promise<Draft | null> {
  const bareHost = host.toLowerCase().replace(/^www\./, "");
  const literal = JSON.stringify(bareHost);
  const query = `SELECT ?logo ?site WHERE { ?item wdt:P856 ?site . FILTER(CONTAINS(LCASE(STR(?site)), ${literal})) ?item wdt:P154 ?logo } LIMIT 5`;
  const response = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, {
    headers: { "user-agent": PUBLIC_SOURCE_USER_AGENT, accept: "application/sparql-results+json" },
    timeoutMs: limits.wikidataMs,
    signal,
  });
  if (response.status !== 200) {
    await response.cancel();
    return null;
  }
  const data = await response.json<SparqlResults>();
  for (const binding of data.results?.bindings ?? []) {
    try {
      // CONTAINS also matches other sites ("x.com" is in "dropbox.com"), so keep the exact host only.
      if (new URL(binding.site?.value ?? "").hostname.toLowerCase().replace(/^www\./, "") !== bareHost) continue;
      const url = new URL(binding.logo?.value ?? "");
      if (url.protocol === "http:") url.protocol = "https:";
      if (url.protocol === "https:" && url.href.length <= MAX_FALLBACK_URL_CHARS) {
        return { url: url.href, role: "site-logo", foundIn: "public-source", name: "", basename: "logo", format: formatOf(url.href) };
      }
    } catch {
      // Not a URL: try the next binding.
    }
  }
  return null;
}

/**
 * Assets from sources that do not depend on the blocked page (spec 8.9): the preflight page head, Google's favicon
 * service and the Wikidata logo. At most `MAX_FALLBACK_ASSETS`, with URLs of at most `MAX_FALLBACK_URL_CHARS`. Never
 * throws: every source that fails is left out.
 */
export async function buildFallback(input: { host: string; head: PageHead | null; fetch: SafeFetch; signer: Signer; signal: AbortSignal }): Promise<Asset[]> {
  const { host, head, fetch, signer, signal } = input;
  const site = head?.siteName ?? capitalize(hostLabel(host));
  const quietly = <T>(task: () => Promise<T>) => task().catch(() => null);
  const [favicon, logo] = await Promise.all([quietly(() => googleFavicon(host, fetch, signal)), quietly(() => wikidataLogo(host, fetch, signal))]);

  const drafts: Draft[] = [];
  const add = (url: string, role: AssetRole, type?: string) => {
    if (url.length > MAX_FALLBACK_URL_CHARS) return false;
    try {
      drafts.push({ url, role, foundIn: "public-source", name: "", basename: "", format: formatOf(url, type) });
      return true;
    } catch {
      return false; // Unparsable URL.
    }
  };
  const addSome = (items: { url: string; type?: string }[], role: AssetRole, max: number) => {
    let added = 0;
    for (const item of items) if (added < max && add(item.url, role, item.type)) added += 1;
  };
  if (logo) drafts.push(logo);
  addSome((head?.jsonLdLogos ?? []).map((url) => ({ url })), "site-logo", MAX_JSON_LD_LOGOS);
  addSome((head?.icons ?? []).map((icon) => ({ url: icon.href, type: icon.type })), "favicon", MAX_HEAD_ICONS);
  if (favicon) drafts.push(favicon);
  addSome((head?.ogImages ?? []).map((url) => ({ url })), "social", MAX_SOCIAL_IMAGES);

  const label: Record<string, string> = { "site-logo": "logo", favicon: "favicon", social: "social image" };
  for (const draft of drafts) {
    draft.name = `${site} ${label[draft.role] ?? "image"}`;
    draft.basename = label[draft.role] ?? "image";
  }
  return toAssets(drafts, host, signer).slice(0, MAX_FALLBACK_ASSETS);
}
