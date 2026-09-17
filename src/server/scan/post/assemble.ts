import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Asset, AssetFormat, AssetKind, AssetSource, FoundIn, HiddenReason, Tone, WarningCode } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import type { AssetsOutput, CapturedImage, CandidateContext, PostInput, RawCandidate } from "../types";
import { originalCandidates, variantKey } from "./cdn";
import { extensionFor, formatFromContentType, formatFromUrl, sniffFormat } from "./format";
import { createFilenamer, displayName } from "./naming";
import { noiseReason, svgNoiseReason } from "./noise";
import { decodeDataUri, extractStylesheetUrls } from "./parse";
import { assignRole, logoScore, relevanceScore } from "./roles";
import { createToneBudget, type ToneBudget } from "./tone";
import { groupVariants, pickBest, sizeScore, type SizeHints, type VariantMember } from "./variants";
import { BROWSER_USER_AGENT, createLimiter, verifyUrl, type Limiter } from "./verify";

/**
 * Builds the final `Asset[]` from the collector output and the captured network (spec 8.1 to 8.8): URL records, noise,
 * size variants, CDN originals and probes within the deadline, roles and scores, inline SVGs, names, signing, caps.
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
  uses: Set<number>;
  capture?: CapturedImage;
  contentType?: string;
  server?: string;
  inline?: { mime: string; buffer: Buffer };
}

type Resolved =
  | { kind: "inline"; member: UrlRecord }
  | { kind: "remote"; url: string; format: AssetFormat; width?: number; height?: number; bytes?: number; tone?: Tone; body?: Buffer; contentType: string }
  | { kind: "failed" }
  | { kind: "skipped" };

interface Draft {
  asset: Asset;
  url?: string;               // http(s) URL for the basename
  label?: string;
  linkText?: string;
  jsonLd: boolean;
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

    const tone = createToneBudget();
    let probes = 0;
    const resolve = async (members: UrlRecord[], best: UrlRecord): Promise<Resolved> => {
      const byUrl = new Map(members.map((member) => [member.url, member]));
      const attempts = new Set<string>();
      if (best.scheme === "http") for (const url of originalCandidates(best.url, { pageUrl, server: best.server })) attempts.add(url);
      for (const member of [...members].sort((a, b) => sizeScore(b) - sizeScore(a))) attempts.add(member.url);
      let skipped = false;
      let failed = false;
      for (const url of attempts) {
        const member = byUrl.get(url);
        if (member?.inline) return { kind: "inline", member };
        if (member?.capture) {
          return {
            kind: "remote", url, format: formatOf(member), contentType: member.contentType ?? "", tone: member.capture.tone,
            bytes: member.bytes, ...sizeOf(member),
          };
        }
        if (member && member.scheme !== "http") continue;
        if (member) {
          if (probes >= limits.maxDeclaredProbes) {
            skipped = true;
            continue;
          }
          probes++;
        }
        const result = await limiter.run((signal) => verifyUrl(url, { fetch: input.fetch, pageUrl, signal, deadline: verifyDeadline }));
        if (result.ok) {
          return { kind: "remote", url, format: result.format, contentType: result.contentType, width: result.width, height: result.height, bytes: result.bytes, body: result.body };
        }
        if (result.reason === "verify-skipped") skipped = true;
        else failed = true;
      }
      if (skipped) warnings.add("verify-skipped");
      return failed && !skipped ? { kind: "failed" } : { kind: "skipped" };
    };

    const groups = groupVariants(kept)
      .map((members) => ({ members, best: pickBest(members) }))
      .sort((a, b) => provisionalScore(b.members, b.best) - provisionalScore(a.members, a.best));

    const fileDrafts = await Promise.all(
      groups.map(async ({ members, best }) => {
        const resolved = await resolve(members, best);
        if (resolved.kind === "failed") hide("probe-failed");
        if (resolved.kind === "failed" || resolved.kind === "skipped") return null;
        return fileAsset(members, best, resolved, tone);
      }),
    );
    // A skipped check that fell back to the page's own version drops nothing but is still partial work.
    if (limiter.skipped > 0) warnings.add("verify-skipped");

    const svgDrafts = await inlineSvgAssets(input, tone, hide);
    const drafts = [...fileDrafts.filter((draft): draft is Draft => draft !== null), ...svgDrafts];
    return finish(drafts, input, hidden, warnings);
  } finally {
    limiter.close();
  }
}

/** Candidates, stylesheet URLs of unreadable sheets, manifest icons, /favicon.ico and network-only images, by URL. */
async function buildRecords(input: PostInput, baseUrl: string, limiter: Limiter, deadline: number): Promise<Map<string, UrlRecord>> {
  const { collector, network, page } = input;
  const pageUrl = page.finalUrl;
  const records = new Map<string, UrlRecord>();
  let nextGroup = Math.max(0, ...collector.candidates.map((c) => c.group)) + 1;
  let nextOrder = Math.max(collector.page.elementCount, ...collector.candidates.map((c) => c.order)) + 1;
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
        labelOrder: Infinity, logoScore: 0, logoWord: false, logoWall: false, declaredOnly: true, jsonLd: false, uses: new Set(),
      };
      records.set(url, record);
    }
    if (!record.foundIn.includes(candidate.foundIn)) record.foundIn.push(candidate.foundIn);
    if (!record.groups.includes(candidate.group)) record.groups.push(candidate.group);
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

  // Stylesheets the page could not read through CSSOM, from their captured text
  const unreadable = new Set(collector.unreadableSheets);
  for (const sheet of network.sheets) {
    if (!unreadable.has(sheet.url) || sheet.status >= 400) continue;
    let previous = null as { property: string; group: number } | null;
    for (const item of extractStylesheetUrls(sheet.cssText, sheet.url)) {
      const group: number = item.imageSet && previous?.property === item.property ? previous.group : nextGroup++;
      previous = item.imageSet ? { property: item.property, group } : null;
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

  // /favicon.ico when the page declares no icon
  if (![...records.values()].some((record) => record.foundIn.includes("icon-link") || record.foundIn.includes("manifest"))) {
    try {
      add(synthetic(new URL("/favicon.ico", pageUrl).href, "icon-link"));
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
        // blob: bytes travel inline and are never merged with other URLs by content
        const blob = blobs.get(record.url);
        const capture = captured.get(record.url);
        if (blob) record.inline = { mime: blob.mime, buffer: Buffer.from(blob.base64, "base64") };
        else if (capture?.blobBase64) record.inline = { mime: capture.contentType, buffer: Buffer.from(capture.blobBase64, "base64") };
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
    logoScore: Math.max(...members.map((m) => m.logoScore)),
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

async function fileAsset(members: UrlRecord[], best: UrlRecord, resolved: Extract<Resolved, { kind: "inline" | "remote" }>, tone: ToneBudget): Promise<Draft> {
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

  if (resolved.kind === "inline") {
    const { member } = resolved;
    const buffer = member.inline!.buffer;
    format = formatOf(member);
    kind = format === "svg" ? "svg" : "image";
    const text = kind === "svg" ? buffer.toString("utf8") : undefined;
    size = text ? svgSize(text) : sizeOf(member);
    asset = defined({
      ...base,
      id: sha1(`inline:${member.sha1 ?? sha1(buffer)}`),
      kind,
      format,
      ...size,
      bytes: buffer.length,
      tone: text ? await tone.svg(text) : await tone.raster(buffer, member.inline!.mime),
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
    const probedTone = resolved.body ? await tone.raster(resolved.body, resolved.contentType) : undefined;
    asset = defined({
      ...base,
      id: sha1(best.key ?? best.url),
      kind,
      format,
      ...size,
      bytes: resolved.bytes,
      tone: resolved.tone ?? probedTone ?? shown?.capture?.tone ?? "unknown",
      display,
      original,
      aspectChanged,
    });
  }

  const role = assignRole({ kind, ...facts, intrinsic: size });
  const score = relevanceScore({ role, visible: facts.visible, renderedWidth: facts.rendered?.width, renderedHeight: facts.rendered?.height, order: facts.order });
  return { asset: { ...asset, role, score, name: "", filename: "" }, url, label: facts.label, linkText: facts.linkText, jsonLd: facts.jsonLd };
}

async function inlineSvgAssets(input: PostInput, tone: ToneBudget, hide: (reason: HiddenReason) => void): Promise<Draft[]> {
  const seen = new Set<string>();
  const svgs = input.collector.svgs.filter((svg) => {
    const reason = svgNoiseReason(svg, limits.svgMaxBytes);
    if (reason) hide(reason);
    if (reason || seen.has(svg.hash)) return false;
    seen.add(svg.hash);
    return true;
  });
  return Promise.all(
    svgs.map(async (svg): Promise<Draft> => {
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
        tone: await tone.svg(svg.markup),
        display: null,
        original: null,
        inline: { mime: "image/svg+xml" as const, text: svg.markup },
        hasLiveText: svg.hasLiveText || undefined,
      });
      return { asset, label: svg.label, linkText: svg.linkText, jsonLd: false };
    }),
  );
}

/** Sorts by relevance, caps the count, names, makes filenames unique and signs remote sources. */
function finish(drafts: Draft[], input: PostInput, hidden: Partial<Record<HiddenReason, number>>, warnings: Set<WarningCode>): AssetsOutput {
  drafts.sort((a, b) => b.asset.score - a.asset.score || a.asset.order - b.asset.order || (a.asset.id < b.asset.id ? -1 : 1));
  if (drafts.length > limits.maxAssets) {
    drafts.length = limits.maxAssets;
    warnings.add("truncated");
  }

  const index = new Map<Draft, number>();
  const counters: Record<AssetKind, number> = { svg: 0, image: 0 };
  for (const draft of [...drafts].sort((a, b) => a.asset.order - b.asset.order)) index.set(draft, ++counters[draft.asset.kind]);

  const siteName = input.page.siteName || siteLabel(input.page.host);
  const filename = createFilenamer(siteName);
  const signed = new Map<string, string>();
  const sign = (source: AssetSource | null) => {
    if (!source) return;
    if (!signed.has(source.url)) {
      let proxy = "";
      try {
        proxy = input.signer.sign(source.url);
      } catch {
        // over the per-scan signing cap: the client uses the direct URL only
      }
      signed.set(source.url, proxy);
    }
    source.proxy = signed.get(source.url)!;
  };

  const ids = new Set<string>();
  const assets = drafts.map((draft) => {
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
  return { assets, hidden, warnings: [...warnings] };
}
