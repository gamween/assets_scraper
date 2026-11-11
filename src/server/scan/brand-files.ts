import { createHash } from "node:crypto";
import type { BrandFile, BrandFileType } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { BROWSER_USER_AGENT } from "@/server/net/safe-fetch";
import { brandFileType, isArchiveOrDocument, isBrandFileWord, isBrandWord, isGenericLabel, linkKey, siteOf } from "./inpage/brand";
import type { RawBrandFileLink, SafeFetch } from "./types";

/**
 * Brand files (spec 8.1): the archives, guidelines and logo files a page offers for download, which the asset list never
 * holds because the page does not show them. An audit of 17 partner logos on 11/11/2026 found the official files of most
 * of them behind such links: arbitrum.io's logo archives, token2049.com's ZIPs on a DigitalOcean bucket, stellar.org's
 * logo pack and guidelines on cdn.sanity.io, and monad.xyz's 29.7 MB kit, which only its code knows the URL of.
 *
 * The collector hands over the links (`RawBrandFileLink`) and the capture the paths a brand page's scripts quote
 * (`CapturedNetwork.scriptFiles`); this module keeps the brand files among them, names them, and asks each host for the
 * size, through `safeFetch` like every other request to a URL a page chose.
 */

/** Links to brand files the collector hands over: four times what a scan keeps, so the rules here have room to choose. */
export const collectorBrandFileLinks = (): number => limits.maxBrandFiles * 4;

/** Quoted paths a scan keeps from the scripts of one page, before the rules below pick the brand files among them. */
export const MAX_SCRIPT_FILE_PATHS = 200;

/** Longest name a brand file gets, and the longest URL one may have. */
const MAX_NAME_CHARS = 120;
const MAX_URL_CHARS = 2_048;
/** Size probes in flight at once. A kit page links a handful of files, often on one bucket. */
const PROBE_CONCURRENCY = 6;

/**
 * A quoted path or URL ending in a brand file extension, the way a page's code holds a download it starts on a click:
 * monad.xyz's "Download kit" button runs `a.href = "/brand-page-assets/Monad Brand and Media Kit.zip"`, so the file is in
 * no link. A path may hold spaces, a URL may not; neither crosses a quote, a line, an angle bracket, a backslash or the
 * `?` or `#` a query starts with, which is read once, after the extension. Linear in the text: every run starts at a
 * quote and stops at the next one, so no character is read from two starts.
 */
const FILE_LITERAL = /(["'`])((?:https?:\/\/[^\s"'`<>\\?#]{1,300}?|\/[^\n"'`<>\\?#]{0,300}?)\.(?:zip|pdf|ai|eps|svg|png))(?:[?#][^\s"'`<>\\]{0,200})?\1/gi;

/** The distinct file paths and URLs a script quotes, in order, at most `max`. */
export function quotedFilePaths(text: string, max: number = MAX_SCRIPT_FILE_PATHS): string[] {
  const found = new Set<string>();
  if (max <= 0) return [];
  for (const match of text.matchAll(FILE_LITERAL)) {
    found.add(match[2]);
    if (found.size >= max) break;
  }
  return [...found];
}

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** The decoded path segments of a URL. */
const segmentsOf = (url: URL): string[] => url.pathname.split("/").filter(Boolean).map(decode);

/**
 * True for a page whose URL names a brand, press or media kit page: the pages whose scripts a scan reads for downloads
 * (`limits.brandScript*`), and whose links count as brand files whatever they are called.
 */
export function isBrandPage(pageUrl: string): boolean {
  try {
    return segmentsOf(new URL(pageUrl)).some(isBrandWord);
  } catch {
    return false;
  }
}

/** True when two URLs belong to one site, the collector's rule (`siteOf`): a page's own scripts, not an ad network's. */
export function sameSite(a: string, b: string): boolean {
  try {
    return siteOf(new URL(a).hostname) === siteOf(new URL(b).hostname);
  } catch {
    return false;
  }
}

/** Single line text, no control characters, cut. */
const clean = (text: string | undefined): string =>
  (text ?? "").replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);

/** A content hash or a UUID: stellar.org's `c155385509c73b245ff4f752ade94048a06245bc.pdf` says nothing about the file. */
const OPAQUE = /^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const isOpaqueName = (stem: string): boolean => OPAQUE.test(stem);

/** A file name as a name: `1225_Arbitrum_Logo_FullColorNavy.zip` reads `1225 Arbitrum Logo FullColorNavy`. */
function readableStem(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const stem = (fileName.split(/[\\/]/).pop() ?? "").replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  if (!stem || isOpaqueName(stem)) return undefined;
  return clean(stem.replace(/[-_]+/g, " ")) || undefined;
}

/**
 * The name of a brand file, from what says the most about it: a label that is not a download verb (stellar.org's
 * "Stellar logo pack", on one of the two links to that ZIP), the file name `download` asks for, the file name in the
 * URL unless it is a hash, the heading of its card ("Discover the brand guide" over a PDF named by hash), and last the
 * type.
 */
function nameOf(links: RawBrandFileLink[], url: URL, type: BrandFileType): string {
  const labels = links.flatMap((link) => [clean(link.text), clean(link.label)]).filter(Boolean);
  return (
    labels.find((label) => !isGenericLabel(label)) ??
    links.map((link) => readableStem(link.download)).find(Boolean) ??
    readableStem(segmentsOf(url).pop()) ??
    links.map((link) => clean(link.caption)).find(Boolean) ??
    `${type.toUpperCase()} file`
  );
}

/** The id of a brand file: stable for its URL, short enough to read back from a summary. */
const brandFileId = (url: string): string => createHash("sha1").update(url).digest("hex").slice(0, 12);

/** An absolute http(s) URL without its fragment, or undefined. */
function httpUrl(value: string, base: string): URL | undefined {
  if (value.length > MAX_URL_CHARS) return undefined;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.href.length <= MAX_URL_CHARS ? url : undefined;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The collector's links as post-processing reads them: an `href` and a `text`, and the three optional strings. A
 * main-world page can replace the collector, so every field is checked again here.
 */
function safeLinks(links: unknown): RawBrandFileLink[] {
  if (!Array.isArray(links)) return [];
  const kept: RawBrandFileLink[] = [];
  for (const link of links.slice(0, collectorBrandFileLinks())) {
    if (!isRecord(link) || typeof link.href !== "string" || typeof link.text !== "string") continue;
    const optional = (key: "label" | "download" | "caption") => (typeof link[key] === "string" && link[key] !== "" ? { [key]: String(link[key]).slice(0, 200) } : {});
    kept.push({ href: link.href, text: link.text.slice(0, 200), ...optional("label"), ...optional("download"), ...optional("caption") });
  }
  return kept;
}

/**
 * Whether a path a script quotes is a brand file. Stricter than a link, which a person put on the page to be clicked:
 * a brand page's scripts are the whole site's bundle, and monad.xyz's also quote `/developers/eips-for-designers/
 * eips-logo.png` and `/socials/discord.svg`. An archive or a document needs a brand word somewhere in its path, an image
 * one in a folder name (`/brand-page-assets/Logomark.svg`), not only in its own name.
 */
function isScriptBrandFile(url: URL, type: BrandFileType): boolean {
  const segments = segmentsOf(url);
  return isArchiveOrDocument(type) ? segments.some(isBrandFileWord) : segments.slice(0, -1).some(isBrandFileWord);
}

export interface BrandFilesInput {
  /** The collector's `brandFiles`, unchecked. */
  links: unknown;
  /** The capture's `scriptFiles`: paths and URLs as the scripts wrote them. */
  scriptFiles?: string[];
  /** The page's final URL, which a path from a script is relative to. */
  pageUrl: string;
  /**
   * True for a URL the scan already holds as an asset or a candidate: a vector the page shows and also links is in the
   * asset list, with its preview and its size, and does not need a second row.
   */
  known?: (url: string) => boolean;
}

/**
 * The brand files of a page, links first in page order, then the files only its scripts name, at most
 * `limits.maxBrandFiles`. Two links to one URL are one file, named from the better of their labels, and a trailing slash
 * makes no other URL (`linkKey`, the brand links' rule).
 */
export function brandFilesFrom(input: BrandFilesInput): BrandFile[] {
  const byUrl = new Map<string, { url: URL; type: BrandFileType; links: RawBrandFileLink[]; foundIn: BrandFile["foundIn"] }>();
  for (const link of safeLinks(input.links)) {
    const url = httpUrl(link.href, input.pageUrl);
    if (!url) continue;
    const type = brandFileType(decode(url.pathname)) ?? (link.download ? brandFileType(link.download) : undefined);
    if (!type) continue;
    const entry = byUrl.get(linkKey(url));
    if (entry) entry.links.push(link);
    else byUrl.set(linkKey(url), { url, type, links: [link], foundIn: "link" });
  }
  for (const path of (input.scriptFiles ?? []).slice(0, MAX_SCRIPT_FILE_PATHS)) {
    if (typeof path !== "string") continue;
    const url = httpUrl(path, input.pageUrl);
    if (!url || byUrl.has(linkKey(url))) continue;
    const type = brandFileType(decode(url.pathname));
    if (!type || !isScriptBrandFile(url, type)) continue;
    byUrl.set(linkKey(url), { url, type, links: [], foundIn: "script" });
  }

  const files: BrandFile[] = [];
  for (const { url, type, links, foundIn } of byUrl.values()) {
    if (files.length >= limits.maxBrandFiles) break;
    if (!isArchiveOrDocument(type) && input.known?.(url.href)) continue;
    files.push({ id: brandFileId(url.href), url: url.href, name: nameOf(links, url, type), type, foundIn });
  }
  return files;
}

/**
 * The size a host announced: the total of a `content-range` when it honoured the range, else the `content-length` of a
 * whole answer that is not encoded. Nothing for an HTML page, which is a challenge or a sign-in page standing in for
 * the file (arbitrum.io answers its archives with Cloudflare's), and nothing for a refusal.
 */
function announcedSize(status: number, headers: Headers): number | undefined {
  if (/^(?:text\/html|application\/xhtml)/i.test(headers.get("content-type") ?? "")) return undefined;
  const whole =
    status === 206 ? /\/\s*(\d+)\s*$/.exec(headers.get("content-range") ?? "")?.[1]
    : status === 200 && !headers.has("content-encoding") ? headers.get("content-length")
    : undefined;
  const bytes = Number(whole);
  return whole !== undefined && whole !== null && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

export interface ProbeOptions {
  fetch: SafeFetch;
  /** The scanned page, sent as the referrer: the scan's browser asked for the page's files from it. */
  referer: string;
  signal: AbortSignal;
  /** Epoch ms after which no probe starts and none runs on: the end of post-processing's network time. */
  deadline: number;
}

/**
 * Asks the host of each brand file for its size: one GET of the first byte, through `safeFetch`, the body never read.
 * A file whose host does not answer in `limits.brandFileProbeMs`, or by the deadline, keeps no size, and is still
 * reported: the link is what the page offers, whether or not its host talks to a program.
 */
export async function probeBrandFiles(files: BrandFile[], options: ProbeOptions): Promise<BrandFile[]> {
  const probed = files.slice();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < probed.length) {
      const index = next++;
      const timeoutMs = Math.min(limits.brandFileProbeMs, options.deadline - Date.now());
      if (timeoutMs <= 0 || options.signal.aborted) return;
      const file = probed[index];
      try {
        const response = await options.fetch(file.url, {
          // The browser's user agent: a host that refuses a program by its user agent would answer the probe with a
          // page, and the file would read as one without a size.
          headers: { range: "bytes=0-0", accept: "*/*", "user-agent": BROWSER_USER_AGENT, referer: options.referer },
          timeoutMs,
          maxBytes: 1_024,
          maxRedirects: limits.proxyMaxRedirects,
          signal: options.signal,
        });
        const bytes = announcedSize(response.status, response.headers);
        await response.cancel();
        if (bytes !== undefined) probed[index] = { ...file, bytes };
      } catch {
        // Unreachable, refused or out of time: the file is reported without a size.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, probed.length) }, worker));
  return probed;
}

/** Leaves out the vectors and rasters the final asset list holds after all, by their display or original URL. */
export function withoutAssets(files: BrandFile[], assetUrls: Set<string>): BrandFile[] {
  return files.filter((file) => isArchiveOrDocument(file.type) || !assetUrls.has(file.url));
}
