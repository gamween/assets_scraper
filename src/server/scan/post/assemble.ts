import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Asset, AssetFormat, AssetKind, AssetSource, FoundIn, HiddenReason, Tone, WarningCode } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { SignLimitError } from "@/server/security/sign";
import type { AssetsOutput, CapturedImage, CandidateContext, PostInput, RawCandidate } from "../types";
import { originalCandidates, variantKey } from "./cdn";
import { extensionFor, formatFromContentType, formatFromUrl, sniffFormat } from "./format";
import { createFilenamer, displayName } from "./naming";
import { noiseReason, svgNoiseReason } from "./noise";
import { decodeDataUri, extractStylesheetUrls } from "./parse";
import { assignRole, isSpriteSheet, logoScore, relevanceScore } from "./roles";
import { createToneBudget } from "./tone";
import { groupVariants, pickBest, sizeScore, type SizeHints, type VariantMember } from "./variants";
import { BROWSER_USER_AGENT, createLimiter, verifyUrl, type Limiter } from "./verify";

/**
 * Builds the final `Asset[]` from the collector output and the captured network (spec 8.1 to 8.8): URL records, noise,
 * size variants, CDN originals and probes within the deadline, roles and scores, inline SVGs, caps, tones, names, signing.
 */

const ELEMENT_SOURCES = new Set<FoundIn>([
  "img", "picture", "lazy-attribute", "noscript", "video-poster", "svg-image", "object-embed",
  "css-background", "css-mask", "css-pseudo", "css-other", "shadow-dom", "iframe",
]);
const MANIFEST_MS = 3_000;
const MANIFEST_MAX_BYTES = 512_000;

interface UrlRecord extends VariantMember, SizeHints {
  scheme: "http" | "data" | "blob";
  foundIn: FoundIn[];
  order: number;
  visible: boolean;
  rendered?: { width: number; height: number };
  label?: string;
  labelOrder: number;
  linkText?: string;
  logoScore: number;
  logoWord: boolean;
  logoWall: boolean;
  declaredOnly: boolean;
  jsonLd: boolean;
  implicit: boolean;          // /favicon.ico added without the page declaring it
  groupSet: Set<number>;      // `groups` as a set: one URL can be shared by thousands of elements
  uses: Set<number>;
  capture?: CapturedImage;
  contentType?: string;
  server?: string;
  inline?: { mime: string; buffer: Buffer };
}

type Resolved =
  | { kind: "inline"; member: UrlRecord }
  | {
      kind: "remote"; url: string; format: AssetFormat; width?: number; height?: number; bytes?: number; tone?: Tone; body?: Buffer;
      markup?: string; contentType: string;
    }
  | { kind: "noise"; reason: HiddenReason }
  | { kind: "failed" }
  | { kind: "skipped" };

/** Bytes to tone once every asset is known; `fallback` replaces an `unknown` result. */
type ToneJob = { svg: string } | { raster: Buffer; contentType: string; fallback?: Tone };

interface Draft {
  asset: Asset;
  url?: string;               // http(s) URL for the basename
  label?: string;
  linkText?: string;
  jsonLd: boolean;
  toneJob?: ToneJob;
  inlineRasterBytes: number;  // raster bytes sent to the client as base64
}

const sha1 = (value: string | Buffer) => createHash("sha1").update(value).digest("hex");
const area = (size?: { width?: number; height?: number }) => (size?.width ?? 0) * (size?.height ?? 0);
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** Width and height of an SVG from its root attributes, else from its viewBox. */
export function svgSize(markup: string): { width?: number; height?: number } {
  const root = /<svg\b[^>]*>/i.exec(markup)?.[0] ?? "";
  const attribute = (name: string) => Number(new RegExp(`\\s${name}\\s*=\\s*["']\\s*(\\d*\\.?\\d+)(?:px)?\\s*["']`, "i").exec(root)?.[1]) || undefined;
  const width = attribute("width");
  const height = attribute("height");
  if (width && height) return { width, height };
  const box = /\sviewBox\s*=\s*["']([^"']+)["']/i.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  return box?.length === 4 && box[2] > 0 && box[3] > 0 ? { width: box[2], height: box[3] } : {};
}

/** "linear" for linear.app, nothing for IP addresses. */
const siteLabel = (host: string) => {
  const hostname = host.replace(/:\d+$/, "").replace(/^www\./, "");
  if (/^[\d.]+$|^\[/.test(hostname)) return "";
  const labels = hostname.split(".");
  return labels.length > 1 ? labels.at(-2)! : labels[0];
};

/**
 * `hidden` is every asset drop of the scan (spec 8.1, 8.2): it starts from the collector's own drops (`collector.noise`:
 * Lottie frames, unreferenced symbols, oversized inline SVGs) and adds what post-processing drops. The engine sums it
 * with the fonts' counts into `stats.hidden` and does not add `collector.noise` again.
 */
export async function assembleAssets(input: PostInput): Promise<AssetsOutput> {
  const { collector, page } = input;
  const pageUrl = page.finalUrl;
  const baseUrl = collector.page.baseUrl || pageUrl;
  const hidden: Partial<Record<HiddenReason, number>> = { ...collector.noise };
  const hide = (reason: HiddenReason) => {
    hidden[reason] = (hidden[reason] ?? 0) + 1;
  };
  const warnings = new Set<WarningCode>();
  const verifyDeadline = Math.min(input.deadline, Date.now() + limits.verifyMs);
  const limiter = createLimiter({ concurrency: limits.verifyConcurrency, deadline: verifyDeadline, signal: input.signal });

  try {
    const records = await buildRecords(input, baseUrl, limiter, verifyDeadline);
    const kept = [...records.values()].filter((record) => {
      const reason = recordNoise(record);
      if (reason) hide(reason);
      return !reason;
    });

    let probes = 0;
    const resolve = async (members: UrlRecord[], best: UrlRecord): Promise<Resolved> => {
      const byUrl = new Map(members.map((member) => [member.url, member]));
      const attempts = new Set<string>();
      if (best.scheme === "http") for (const url of originalCandidates(best.url, { pageUrl, server: best.server })) attempts.add(url);
      for (const member of [...members].sort((a, b) => sizeScore(b) - sizeScore(a))) attempts.add(member.url);
      let skipped = false;
      let failed = false;
      let noise: HiddenReason | undefined;
      for (const url of attempts) {
        const member = byUrl.get(url);
        if (member?.inline) return { kind: "inline", member };
        if (member?.capture) {
          return {
            kind: "remote", url, format: formatOf(member), contentType: member.contentType ?? "", tone: member.capture.tone,
            bytes: member.bytes, markup: member.capture.svgText, ...sizeOf(member),
          };
        }
        if (member && member.scheme !== "http") continue;
        if (member) {
          if (probes >= limits.maxDeclaredProbes) {
            skipped = true;
            warnings.add("verify-skipped");
            continue;
          }
          probes++;
        }
        const result = await limiter.run((signal) => verifyUrl(url, { fetch: input.fetch, pageUrl, signal, deadline: verifyDeadline }));
        if (result.ok) {
          // The noise rules again, with the size and type the request found (spec 8.2): a 2x2 file is noise wherever it was declared.
          const reason = noiseReason({ url, contentType: result.contentType, width: result.width, height: result.height, bytes: result.bytes });
          if (reason) {
            noise ??= reason;
            continue;
          }
          return {
            kind: "remote", url, format: result.format, contentType: result.contentType, width: result.width, height: result.height,
            bytes: result.bytes, body: result.body,
          };
        }
        if (result.reason === "verify-skipped") skipped = true;
        else failed = true;
      }
      if (skipped) {
        warnings.add("verify-skipped");
        return { kind: "skipped" };
      }
      if (noise) return { kind: "noise", reason: noise };
      return failed ? { kind: "failed" } : { kind: "skipped" };
    };

    const groups = groupVariants(kept)
      .map((members) => {
        const best = pickBest(members);
        return { members, best, score: provisionalScore(members, best) };
      })
      .sort((a, b) => b.score - a.score);

    const fileDrafts = await Promise.all(
      groups.map(async ({ members, best }) => {
        const resolved = await resolve(members, best);
        // A missing or unusable /favicon.ico was never declared by the page, so it is not counted (spec 8.2).
        const declared = members.some((member) => !member.implicit);
        if (declared && resolved.kind === "failed") hide("probe-failed");
        if (declared && resolved.kind === "noise") hide(resolved.reason);
        if (resolved.kind !== "inline" && resolved.kind !== "remote") return null;
        return fileAsset(members, best, resolved);
      }),
    );
    // A skipped check that fell back to the page's own version drops nothing but is still partial work.
    if (limiter.skipped > 0) warnings.add("verify-skipped");

    const drafts = rank([...fileDrafts.filter((draft): draft is Draft => draft !== null), ...inlineSvgAssets(input, hide)], warnings);
    // Tones last, in relevance order: the time budget only counts tone work, never the fetches above.
    await applyTones(drafts);
    return { assets: finish(drafts, input, warnings), hidden, warnings: [...warnings] };
  } finally {
    limiter.close();
  }
}

/** Candidates, URLs of captured stylesheets, manifest icons, /favicon.ico and network-only images, by URL. */
async function buildRecords(input: PostInput, baseUrl: string, limiter: Limiter, deadline: number): Promise<Map<string, UrlRecord>> {
  const { collector, network, page } = input;
  const pageUrl = page.finalUrl;
  const records = new Map<string, UrlRecord>();
  // A loop, not Math.max(...list): a heavy page gives more candidates than a call can take as arguments.
  let nextGroup = 0;
  let nextOrder = collector.page.elementCount;
  let iconLink = false;
  for (const candidate of collector.candidates) {
    nextGroup = Math.max(nextGroup, candidate.group);
    nextOrder = Math.max(nextOrder, candidate.order);
    iconLink ||= candidate.foundIn === "icon-link";
  }
  nextGroup++;
  nextOrder++;
  const empty: CandidateContext = {
    header: false, nav: false, footer: false, homeLink: false, logoWord: false, siteWord: false, logoWall: false, shadowRoot: false, iframe: false,
  };
  const synthetic = (url: string, foundIn: FoundIn, patch: Partial<RawCandidate> = {}): RawCandidate => ({
    url, group: nextGroup++, foundIn, order: nextOrder++, visible: false, context: empty, declaredOnly: foundIn === "stylesheet", ...patch,
  });

  const add = (candidate: RawCandidate) => {
    let url = candidate.url;
    const scheme = /^data:/i.test(url) ? "data" : /^blob:/i.test(url) ? "blob" : "http";
    if (scheme === "http") {
      try {
        const parsed = new URL(url, baseUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        url = parsed.href;
      } catch {
        return;
      }
    }
    let record = records.get(url);
    if (!record) {
      record = {
        url, scheme, kind: "raster", groups: [], artDirectedOnly: true, foundIn: [], order: candidate.order, visible: false,
        labelOrder: Infinity, logoScore: 0, logoWord: false, logoWall: false, declaredOnly: true, jsonLd: false, implicit: false,
        groupSet: new Set(), uses: new Set(),
      };
      records.set(url, record);
    }
    if (!record.foundIn.includes(candidate.foundIn)) record.foundIn.push(candidate.foundIn);
    if (!record.groupSet.has(candidate.group)) {
      record.groupSet.add(candidate.group);
      record.groups.push(candidate.group);
    }
    if (candidate.descriptor && !candidate.media && record.preferredGroup === undefined) record.preferredGroup = candidate.group;
    record.artDirectedOnly = record.artDirectedOnly && !!candidate.media;
    if (candidate.descriptor?.w) record.descriptorW = Math.max(record.descriptorW ?? 0, candidate.descriptor.w);
    if (candidate.descriptor?.x) record.descriptorX = Math.max(record.descriptorX ?? 0, candidate.descriptor.x);
    if (candidate.naturalWidth && candidate.naturalHeight && candidate.naturalWidth * candidate.naturalHeight > area({ width: record.naturalWidth, height: record.naturalHeight })) {
      record.naturalWidth = candidate.naturalWidth;
      record.naturalHeight = candidate.naturalHeight;
    }
    for (const match of (candidate.sizes ?? "").matchAll(/(\d+)x(\d+)/gi)) {
      const size = { width: Number(match[1]), height: Number(match[2]) };
      if (area(size) > area({ width: record.declaredWidth, height: record.declaredHeight })) {
        record.declaredWidth = size.width;
        record.declaredHeight = size.height;
      }
    }
    record.visible ||= candidate.visible;
    if (candidate.visible && candidate.rect && area(candidate.rect) > area(record.rendered)) {
      record.rendered = { width: candidate.rect.width, height: candidate.rect.height };
    }
    record.order = Math.min(record.order, candidate.order);
    if (candidate.label && candidate.order < record.labelOrder) {
      record.label = candidate.label;
      record.labelOrder = candidate.order;
    }
    record.linkText ??= candidate.linkText;
    record.logoScore = Math.max(record.logoScore, logoScore(candidate.context, candidate.visible, candidate.rect));
    record.logoWord ||= candidate.context.logoWord;
    record.logoWall ||= candidate.context.logoWall;
    record.declaredOnly &&= candidate.declaredOnly;
    record.jsonLd ||= candidate.foundIn === "json-ld";
    if (ELEMENT_SOURCES.has(candidate.foundIn)) record.uses.add(candidate.group);
  };

  for (const candidate of collector.candidates) add(candidate);

  // Captured stylesheet text (spec 8.1). The CSSOM walk already declared every URL of the sheets it could read, so this
  // adds what it could not reach: cross-origin sheets, their @import children, sheets whose response URL differs from
  // their href after a redirect, and sheets no longer in the document. The URLs of one image-set() declaration share a group.
  const parsedSheets = new Set<string>();
  for (const sheet of network.sheets) {
    if (sheet.status < 200 || sheet.status >= 400 || parsedSheets.has(sheet.url) || !/url\(|image-set\(/i.test(sheet.cssText)) continue;
    parsedSheets.add(sheet.url);
    const setGroups = new Map<number, number>();
    for (const item of extractStylesheetUrls(sheet.cssText, sheet.url)) {
      if (records.get(item.url)?.foundIn.includes("stylesheet")) continue;
      let group = item.imageSet ? setGroups.get(item.declaration) : undefined;
      if (group === undefined) {
        group = nextGroup++;
        if (item.imageSet) setGroups.set(item.declaration, group);
      }
      add(synthetic(item.url, "stylesheet", { group }));
    }
  }

  // Web manifest icons, fetched in Node
  if (collector.manifestUrl && /^https?:/i.test(collector.manifestUrl)) {
    const manifestUrl = collector.manifestUrl;
    const icons = await limiter.run(async (signal) => {
      try {
        const response = await input.fetch(manifestUrl, {
          headers: { accept: "application/manifest+json,application/json;q=0.9,*/*;q=0.5", "user-agent": BROWSER_USER_AGENT, referer: pageUrl },
          timeoutMs: Math.max(1, Math.min(MANIFEST_MS, deadline - Date.now())),
          maxBytes: MANIFEST_MAX_BYTES,
          signal,
        });
        if (response.status < 200 || response.status > 299) {
          await response.cancel().catch(() => {});
          return [];
        }
        const manifest = JSON.parse(await response.text()) as { icons?: unknown };
        return Array.isArray(manifest.icons) ? (manifest.icons as { src?: unknown; sizes?: unknown; type?: unknown }[]) : [];
      } catch {
        return [];
      }
    });
    if (Array.isArray(icons)) {
      for (const icon of icons) {
        if (typeof icon?.src !== "string") continue;
        try {
          add(synthetic(new URL(icon.src, manifestUrl).href, "manifest", {
            sizes: typeof icon.sizes === "string" ? icon.sizes : undefined,
            type: typeof icon.type === "string" ? icon.type : undefined,
          }));
        } catch {
          // invalid icon URL
        }
      }
    }
  }

  // /favicon.ico when the page declares no icon link (spec 8.1), manifest icons or not
  if (!iconLink) {
    try {
      const url = new URL("/favicon.ico", pageUrl).href;
      const declared = records.has(url);
      add(synthetic(url, "icon-link"));
      if (!declared) records.get(url)!.implicit = true;
    } catch {
      // no origin
    }
  }

  // Captured bodies, and images only seen on the network
  const captured = new Map<string, CapturedImage>();
  for (const image of network.images) {
    const existing = captured.get(image.url);
    const ok = (status: number) => status >= 200 && status < 300;
    if (!existing || (!ok(existing.status) && ok(image.status))) captured.set(image.url, image);
  }
  for (const image of captured.values()) {
    if (!records.has(image.url) && image.status >= 200 && image.status < 300 && !/^data:/i.test(image.url)) add(synthetic(image.url, "network"));
  }
  const blobs = new Map(collector.blobs.map((blob) => [blob.url, blob]));

  await Promise.all(
    [...records.values()].map(async (record) => {
      if (record.scheme === "http") {
        const capture = captured.get(record.url);
        if (capture) {
          record.capture = capture;
          record.contentType = capture.contentType;
          record.bytes = capture.bytes;
          record.sha1 = capture.sha1;
          record.width = capture.width;
          record.height = capture.height;
          record.server = capture.server;
        }
        record.key = variantKey(record.url, { pageUrl, server: record.server });
      } else if (record.scheme === "data") {
        const decoded = decodeDataUri(record.url);
        if (decoded) {
          record.inline = decoded;
          record.contentType = decoded.mime;
          record.bytes = decoded.buffer.length;
          record.sha1 = sha1(decoded.buffer);
        }
      } else {
        // blob: bytes, network body first (spec 8.1). They travel inline and are never merged with other URLs by content.
        const blob = blobs.get(record.url);
        const capture = captured.get(record.url);
        if (capture?.blobBase64) record.inline = { mime: capture.contentType, buffer: Buffer.from(capture.blobBase64, "base64") };
        else if (blob) record.inline = { mime: blob.mime, buffer: Buffer.from(blob.base64, "base64") };
        if (record.inline) {
          record.contentType = record.inline.mime;
          record.bytes = record.inline.buffer.length;
        }
      }
      record.kind = formatOf(record) === "svg" ? "svg" : "raster";
      if (record.inline && record.kind === "raster") {
        const meta = await sharp(record.inline.buffer, { failOn: "none", limitInputPixels: false }).metadata().catch(() => null);
        record.width = meta?.width;
        record.height = meta?.height;
      }
    }),
  );
  return records;
}

function formatOf(record: UrlRecord): AssetFormat {
  if (record.inline) {
    const format = formatFromContentType(record.inline.mime, record.url);
    return format === "other" ? sniffFormat(record.inline.buffer) : format;
  }
  const format = record.contentType ? formatFromContentType(record.contentType, record.url) : formatFromUrl(record.url);
  return format === "other" && record.capture?.svgText ? "svg" : format;
}

function sizeOf(record: UrlRecord): { width?: number; height?: number } {
  if (record.width && record.height) return { width: record.width, height: record.height };
  const markup = record.capture?.svgText ?? (record.inline && record.kind === "svg" ? record.inline.buffer.toString("utf8") : undefined);
  if (markup) return svgSize(markup);
  if (record.naturalWidth && record.naturalHeight) return { width: record.naturalWidth, height: record.naturalHeight };
  if (record.declaredWidth && record.declaredHeight) return { width: record.declaredWidth, height: record.declaredHeight };
  return {};
}

function recordNoise(record: UrlRecord): HiddenReason | null {
  if (record.capture && (record.capture.status < 200 || record.capture.status >= 400)) return "not-image";
  if (record.scheme === "data" && !record.inline) return "not-image";
  // SVG markup sent inline has the same cap as inline SVGs (spec 8.2).
  if (record.inline && record.kind === "svg" && record.inline.buffer.length > limits.svgMaxBytes) return "svg-too-large";
  return noiseReason({
    url: record.url,
    contentType: record.contentType,
    width: record.width,
    height: record.height,
    bytes: record.bytes,
    svgText: record.kind === "svg" && record.scheme === "data" ? record.inline?.buffer.toString("utf8") : undefined,
    blobCaptured: !!record.inline,
  });
}

const union = <T>(lists: T[][]) => [...new Set(lists.flat())];

function groupFacts(members: UrlRecord[]) {
  const byOrder = [...members].sort((a, b) => a.order - b.order);
  const withLabel = [...members].filter((m) => m.label).sort((a, b) => a.labelOrder - b.labelOrder);
  const uses = new Set(members.flatMap((m) => [...m.uses]));
  return {
    foundIn: union(byOrder.map((m) => m.foundIn)),
    visible: members.some((m) => m.visible),
    declaredOnly: members.every((m) => m.declaredOnly),
    order: byOrder[0].order,
    rendered: members.map((m) => m.rendered).filter((r) => r !== undefined).sort((a, b) => area(b) - area(a))[0],
    label: withLabel[0]?.label,
    linkText: byOrder.find((m) => m.linkText)?.linkText,
    logoScore: members.reduce((max, m) => Math.max(max, m.logoScore), 0),
    logoWord: members.some((m) => m.logoWord),
    logoWall: members.some((m) => m.logoWall),
    jsonLd: members.some((m) => m.jsonLd),
    usedCount: Math.max(1, uses.size),
  };
}

/** Relevance before verification, so the most relevant assets are verified first. */
function provisionalScore(members: UrlRecord[], best: UrlRecord): number {
  const facts = groupFacts(members);
  const role = assignRole({ kind: best.kind === "svg" ? "svg" : "image", ...facts, intrinsic: sizeOf(best) });
  return relevanceScore({ role, visible: facts.visible, renderedWidth: facts.rendered?.width, renderedHeight: facts.rendered?.height, order: facts.order });
}

function fileAsset(members: UrlRecord[], best: UrlRecord, resolved: Extract<Resolved, { kind: "inline" | "remote" }>): Draft {
  const facts = groupFacts(members);
  const base = {
    foundIn: facts.foundIn,
    visible: facts.visible,
    declaredOnly: facts.declaredOnly,
    order: facts.order,
    usedCount: facts.usedCount,
    renderedWidth: facts.rendered?.width,
    renderedHeight: facts.rendered?.height,
  };

  let kind: AssetKind;
  let format: AssetFormat;
  let size: { width?: number; height?: number };
  let asset: Omit<Asset, "role" | "score" | "name" | "filename">;
  let url: string | undefined;
  let markup: string | undefined;
  let toneJob: ToneJob | undefined;
  let inlineRasterBytes = 0;

  if (resolved.kind === "inline") {
    const { member } = resolved;
    const buffer = member.inline!.buffer;
    format = formatOf(member);
    kind = format === "svg" ? "svg" : "image";
    const text = kind === "svg" ? buffer.toString("utf8") : undefined;
    markup = text;
    size = text ? svgSize(text) : sizeOf(member);
    toneJob = text ? { svg: text } : { raster: buffer, contentType: member.inline!.mime };
    if (!text) inlineRasterBytes = buffer.length;
    asset = defined({
      ...base,
      id: sha1(`inline:${member.sha1 ?? sha1(buffer)}`),
      kind,
      format,
      ...size,
      bytes: buffer.length,
      tone: "unknown" as const,
      display: null,
      original: null,
      inline: text ? { mime: "image/svg+xml" as const, text } : { mime: member.inline!.mime || "application/octet-stream", base64: buffer.toString("base64") },
    });
  } else {
    format = resolved.format;
    kind = format === "svg" ? "svg" : "image";
    url = resolved.url;
    size = resolved.width && resolved.height ? { width: resolved.width, height: resolved.height } : sizeOf(best);
    const original: AssetSource = defined({ url: resolved.url, proxy: "", format, ...size, bytes: resolved.bytes });
    const loaded = members.filter((m) => m.capture);
    const rendered = loaded.filter((m) => m.visible && m.naturalWidth);
    const shown = rendered.length ? pickBest(rendered) : loaded.length ? pickBest(loaded) : undefined;
    let display = original;
    let aspectChanged: boolean | undefined;
    if (shown && shown.url !== resolved.url) {
      const shownSize = sizeOf(shown);
      display = defined({ url: shown.url, proxy: "", format: formatOf(shown), ...shownSize, bytes: shown.bytes });
      if (shownSize.width && shownSize.height && size.width && size.height) {
        const ratio = shownSize.width / shownSize.height;
        if (Math.abs(size.width / size.height - ratio) / ratio > 0.03) aspectChanged = true;
      }
    }
    markup = kind === "svg" ? (resolved.markup ?? resolved.body?.toString("utf8")) : undefined;
    const shownTone = shown?.capture?.tone;
    if (!resolved.tone && resolved.body) toneJob = { raster: resolved.body, contentType: resolved.contentType, fallback: shownTone };
    asset = defined({
      ...base,
      id: sha1(best.key ?? best.url),
      kind,
      format,
      ...size,
      bytes: resolved.bytes,
      tone: resolved.tone ?? shownTone ?? "unknown",
      display,
      original,
      aspectChanged,
    });
  }

  // A file that only defines symbols (an external sprite sheet) draws nothing on a tile: it ranks with sprite symbols.
  const role = assignRole({ kind, ...facts, intrinsic: size, spriteSymbol: !!markup && isSpriteSheet(markup) });
  const score = relevanceScore({ role, visible: facts.visible, renderedWidth: facts.rendered?.width, renderedHeight: facts.rendered?.height, order: facts.order });
  return {
    asset: { ...asset, role, score, name: "", filename: "" }, url, label: facts.label, linkText: facts.linkText, jsonLd: facts.jsonLd, toneJob,
    inlineRasterBytes,
  };
}

function inlineSvgAssets(input: PostInput, hide: (reason: HiddenReason) => void): Draft[] {
  const seen = new Set<string>();
  const svgs = input.collector.svgs.filter((svg) => {
    const reason = svgNoiseReason(svg, limits.svgMaxBytes);
    if (reason) hide(reason);
    if (reason || seen.has(svg.hash)) return false;
    seen.add(svg.hash);
    return true;
  });
  return svgs.map((svg): Draft => {
    const symbol = svg.source === "sprite-symbol";
    const foundIn: FoundIn[] = [symbol ? "sprite-symbol" : "inline-svg"];
    if (svg.context.shadowRoot) foundIn.push("shadow-dom");
    if (svg.context.iframe) foundIn.push("iframe");
    const rendered = svg.visible && svg.rect ? { width: svg.rect.width, height: svg.rect.height } : undefined;
    const size = svgSize(svg.markup);
    const score = logoScore(svg.context, svg.visible, svg.rect);
    const role = assignRole({
      kind: "svg", foundIn, logoScore: score, logoWord: svg.context.logoWord, logoWall: svg.context.logoWall, label: svg.label,
      rendered, intrinsic: size, spriteSymbol: symbol,
    });
    const asset: Asset = defined({
      id: sha1(`svg:${svg.hash}`),
      kind: "svg" as const,
      role,
      name: "",
      filename: "",
      format: "svg" as const,
      foundIn,
      visible: svg.visible,
      declaredOnly: false,
      order: svg.order,
      score: relevanceScore({ role, visible: svg.visible, renderedWidth: rendered?.width, renderedHeight: rendered?.height, order: svg.order }),
      usedCount: Math.max(1, svg.usedCount),
      ...size,
      renderedWidth: rendered?.width,
      renderedHeight: rendered?.height,
      bytes: Buffer.byteLength(svg.markup),
      tone: "unknown" as const,
      display: null,
      original: null,
      inline: { mime: "image/svg+xml" as const, text: svg.markup },
      hasLiveText: svg.hasLiveText || undefined,
    });
    return { asset, label: svg.label, linkText: svg.linkText, jsonLd: false, toneJob: { svg: svg.markup }, inlineRasterBytes: 0 };
  });
}

/**
 * Sorts by relevance and applies the result caps: inline raster bytes within the blob caps (2 MB each, 16 MB in total,
 * spec 7.4 and 14), then `maxAssets`. Anything cut gives the `truncated` warning.
 */
function rank(drafts: Draft[], warnings: Set<WarningCode>): Draft[] {
  drafts.sort((a, b) => b.asset.score - a.asset.score || a.asset.order - b.asset.order || (a.asset.id < b.asset.id ? -1 : 1));
  let inlineBytes = 0;
  const kept = drafts.filter((draft) => {
    if (!draft.inlineRasterBytes) return true;
    if (draft.inlineRasterBytes <= limits.blobMaxBytes && inlineBytes + draft.inlineRasterBytes <= limits.blobTotalBytes) {
      inlineBytes += draft.inlineRasterBytes;
      return true;
    }
    warnings.add("truncated");
    return false;
  });
  if (kept.length > limits.maxAssets) {
    kept.length = limits.maxAssets;
    warnings.add("truncated");
  }
  return kept;
}

/** Tones in the order of `drafts` (relevance) within the scan tone budget (spec 8.8). */
async function applyTones(drafts: Draft[]): Promise<void> {
  const budget = createToneBudget();
  await Promise.all(
    drafts.map(async ({ asset, toneJob: job }) => {
      if (!job) return;
      const tone = "svg" in job ? await budget.svg(job.svg) : await budget.raster(job.raster, job.contentType);
      asset.tone = tone === "unknown" && "fallback" in job && job.fallback ? job.fallback : tone;
    }),
  );
}

/** Names, makes filenames unique and signs remote sources, most relevant first. */
function finish(drafts: Draft[], input: PostInput, warnings: Set<WarningCode>): Asset[] {
  const index = new Map<Draft, number>();
  const counters: Record<AssetKind, number> = { svg: 0, image: 0 };
  for (const draft of [...drafts].sort((a, b) => a.asset.order - b.asset.order)) index.set(draft, ++counters[draft.asset.kind]);

  const siteName = input.page.siteName || siteLabel(input.page.host);
  const filename = createFilenamer(siteName);
  const signed = new Map<string, string>();
  const sign = (source: AssetSource | null) => {
    if (!source) return;
    let proxy = signed.get(source.url);
    if (proxy === undefined) {
      try {
        proxy = input.signer.sign(source.url);
      } catch (error) {
        if (!(error instanceof SignLimitError)) throw error;
        // Over the per-scan signing cap (spec 11.2): the less relevant sources keep no proxy.
        proxy = "";
        warnings.add("truncated");
      }
      signed.set(source.url, proxy);
    }
    source.proxy = proxy;
  };

  const ids = new Set<string>();
  return drafts.map((draft) => {
    const asset = draft.asset;
    while (ids.has(asset.id)) asset.id = sha1(`${asset.id}:dup`);
    ids.add(asset.id);
    asset.name = displayName({
      kind: asset.kind,
      role: asset.role,
      index: index.get(draft)!,
      siteName,
      label: draft.label,
      jsonLdLogo: draft.jsonLd,
      linkText: draft.linkText,
      url: draft.url,
    });
    asset.filename = filename(asset.name, extensionFor(asset.format));
    sign(asset.display);
    sign(asset.original);
    return asset;
  });
}
