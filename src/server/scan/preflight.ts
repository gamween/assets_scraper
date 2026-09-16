import { NotImplementedError } from "@/server/errors";
import type { SafeFetch } from "./types";

export interface PageHead {
  title?: string;
  siteName?: string;
  icons: { href: string; rel: string; sizes?: string; type?: string }[];
  ogImages: string[];
  jsonLdLogos: string[];
  manifestUrl?: string;
}

export interface PreflightResult {
  finalUrl: string;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  head: PageHead | null;
}

/** parseHead reads at most this many characters of the document. */
const HEAD_SCAN_CHARS = 1024 * 1024;
/** Longer tags are skipped: real `link` and `meta` tags are short, and long ones only carry data URIs. */
const MAX_TAG_CHARS = 16 * 1024;

const ICON_RELS = new Set(["icon", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon", "fluid-icon", "image_src"]);
const SOCIAL_IMAGE_KEYS = new Set(["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]);
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,8});/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const isWhitespace = (char: string) => char === " " || char === "\n" || char === "\t" || char === "\r" || char === "\f";

/** Tolerant attribute parser (double, single or no quotes). Linear in the length of the tag. */
function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let i = 0;
  const skipWhitespace = () => {
    while (i < source.length && isWhitespace(source[i])) i += 1;
  };
  while (i < source.length) {
    while (i < source.length && (isWhitespace(source[i]) || source[i] === "/")) i += 1;
    const nameStart = i;
    while (i < source.length && !isWhitespace(source[i]) && source[i] !== "/" && source[i] !== "=") i += 1;
    const name = source.slice(nameStart, i).toLowerCase();
    skipWhitespace();
    let value = "";
    if (source[i] === "=") {
      i += 1;
      skipWhitespace();
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, i + 1);
        const end = close < 0 ? source.length : close;
        value = source.slice(i + 1, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < source.length && !isWhitespace(source[i])) i += 1;
        value = source.slice(valueStart, i);
      }
    } else if (!name) {
      i += 1;
    }
    if (name && !attributes.has(name)) attributes.set(name, decodeEntities(value));
  }
  return attributes;
}

function absoluteHttpUrl(value: string | undefined, base: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !base) return undefined;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function collectLogos(node: unknown, add: (value: unknown) => void, depth = 0): void {
  if (depth > 10 || !node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectLogos(item, add, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "logo") {
      for (const logo of Array.isArray(value) ? value : [value]) {
        if (typeof logo === "string") add(logo);
        else if (logo && typeof logo === "object") add((logo as { url?: unknown }).url ?? (logo as { contentUrl?: unknown }).contentUrl);
      }
    } else {
      collectLogos(value, add, depth + 1);
    }
  }
}

interface HeadTag {
  name: "link" | "meta" | "base" | "title" | "script";
  attributes: Map<string, string>;
  content?: string;
}

/**
 * Yields `link`, `meta`, `base`, `title` and `script` tags in document order, with the text of `title` and `script`.
 * Skips comments. Every search starts after the previous tag, and a closing marker that is missing once is never
 * searched again, so the scan stays linear on hostile markup.
 */
function* headTags(source: string): Generator<HeadTag> {
  const open = /<!--|<(link|meta|base|title|script)(?=[\s/>])/gi;
  const closers = { title: /<\/title\s*>/gi, script: /<\/script\s*>/gi, comment: /-->/g };
  const missing = new Set<keyof typeof closers>();
  const findClose = (kind: keyof typeof closers, from: number) => {
    if (missing.has(kind)) return null;
    const closer = closers[kind];
    closer.lastIndex = from;
    const match = closer.exec(source);
    if (!match) missing.add(kind);
    return match && { start: match.index, end: closer.lastIndex };
  };

  for (let match = open.exec(source); match; match = open.exec(source)) {
    if (!match[1]) {
      const close = findClose("comment", open.lastIndex);
      if (!close) return;
      open.lastIndex = close.end;
      continue;
    }
    const start = open.lastIndex;
    const end = source.indexOf(">", start);
    if (end < 0) return;
    open.lastIndex = end + 1;
    const name = match[1].toLowerCase() as HeadTag["name"];
    const attributes = end - start <= MAX_TAG_CHARS ? parseAttributes(source.slice(start, end)) : null;
    if (name === "title" || name === "script") {
      const close = findClose(name, end + 1);
      if (!close) continue;
      open.lastIndex = close.end;
      if (attributes) yield { name, attributes, content: source.slice(end + 1, close.start) };
    } else if (attributes) {
      yield { name, attributes };
    }
  }
}

/**
 * Reads what the fallback needs from raw HTML (spec 8.9): title, `og:site_name`, icon links, social images, JSON-LD
 * logos and the manifest link. Scans the first megabyte, makes URLs absolute (http and https only), never throws.
 */
export function parseHead(html: string, baseUrl: string): PageHead {
  const head: PageHead = { icons: [], ogImages: [], jsonLdLogos: [] };
  const tags = [...headTags(html.slice(0, HEAD_SCAN_CHARS))];

  const title = tags.find((tag) => tag.name === "title")?.content;
  const cleanTitle = title && decodeEntities(title).replace(/\s+/g, " ").trim();
  if (cleanTitle) head.title = cleanTitle;

  let base = absoluteHttpUrl(baseUrl, baseUrl);
  const baseHref = tags.find((tag) => tag.name === "base" && tag.attributes.get("href"))?.attributes.get("href");
  base = absoluteHttpUrl(baseHref, base) ?? base;

  for (const { name, attributes, content } of tags) {
    if (name === "link") {
      const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const href = absoluteHttpUrl(attributes.get("href"), base);
      if (!href) continue;
      if (rel.includes("manifest")) head.manifestUrl ??= href;
      if (!rel.some((token) => ICON_RELS.has(token)) || head.icons.some((icon) => icon.href === href)) continue;
      const icon: PageHead["icons"][number] = { href, rel: rel.join(" ") };
      const sizes = attributes.get("sizes")?.trim();
      const type = attributes.get("type")?.trim();
      if (sizes) icon.sizes = sizes;
      if (type) icon.type = type;
      head.icons.push(icon);
    } else if (name === "meta") {
      const key = (attributes.get("property") ?? attributes.get("name") ?? "").trim().toLowerCase();
      const value = attributes.get("content")?.trim();
      if (key === "og:site_name" && value) head.siteName ??= value;
      const url = SOCIAL_IMAGE_KEYS.has(key) ? absoluteHttpUrl(value, base) : undefined;
      if (url && !head.ogImages.includes(url)) head.ogImages.push(url);
    } else if (name === "script" && attributes.get("type")?.trim().toLowerCase() === "application/ld+json") {
      let data: unknown;
      try {
        data = JSON.parse((content ?? "").trim().replace(/^<!--|-->$/g, ""));
      } catch {
        continue;
      }
      collectLogos(data, (value) => {
        const url = typeof value === "string" ? absoluteHttpUrl(value, base) : undefined;
        if (url && !head.jsonLdLogos.includes(url)) head.jsonLdLogos.push(url);
      });
    }
  }

  return head;
}

export function preflight(url: string, options: { fetch: SafeFetch; signal: AbortSignal }): Promise<PreflightResult>;
export async function preflight(): Promise<PreflightResult> {
  throw new NotImplementedError("B: preflight");
}
