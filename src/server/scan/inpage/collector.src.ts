import type { FoundIn, HiddenReason } from "@/lib/contract";
import type {
  CandidateContext,
  CollectorOptions,
  RawCandidate,
  RawCollectorOutput,
  RawFontFaceRule,
  RawFontStatus,
  RawFontUsage,
  RawSvg,
  Rect,
} from "../types";

/**
 * In-page asset collector and SVG normalizer (spec 7.5, 8.1, 8.6), ported from the discovery lab (`lib/inpage.js`).
 *
 * Runs inside the scanned page, normally in a CDP isolated world where `customElements` is null, so it never uses it.
 * It cannot import app code: `parseSrcset` and `extractCssUrls` are copies of `post/parse.ts`, keep them in sync.
 * Returns plain JSON. Caps: `maxElements` walked, `timeBudgetMs`, `maxSvgNormalizations`, `maxSvgBytes` per SVG,
 * `maxSvgTotalBytes` for all SVG markup, blob byte caps. Hitting one sets `stats.truncated`.
 */

declare global {
  var __assetsScraper: { collect(options: CollectorOptions): Promise<RawCollectorOutput> } | undefined;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const MAX_SAME_MARKUP_NORMALIZATIONS = 3;
const MAX_STYLED_SVG_ELEMENTS = 4_000;
const MAX_TEXT_NODES = 20_000;
const BLOB_FETCH_MS = 3_000;

const LAZY_ATTR =
  /^data-(?:lazy-?)?(?:src|srcset|original|original-set|hi-?res(?:-src)?|full(?:-src)?|large(?:-src)?|zoom(?:-src)?|fallback(?:-src)?|bg|background|background-image|image|img|echo|flickity-lazyload|lazy|srcset-lazy|pin-media|retina|2x)$/i;
const LAZY_BACKGROUND_ATTR = /^data-(?:bg|background|background-image|bg-src|lazy-background|image-src)$/i;
/**
 * Spec 8.1 brand link words. A word must start the path segment, the text or a camelCase word (/OurBrand), so
 * /wordpress, /express and /impressum do not match, but it may run on (/brandassets, /logopack, /presse). /logout,
 * /logon and /pressure are left out.
 */
const BRAND_LINK = /(?:^|[^a-z])(?:brand|press(?!ure)|media[- _]?kit|newsroom|logo(?!ut|n(?![a-z]))|guidelines)/i;
const isBrandLink = (text: string) => BRAND_LINK.test(text) || BRAND_LINK.test(text.replace(/([a-z])(?=[A-Z])/g, "$1 "));
/** Second-level labels under a two-letter country code that are public suffixes: shop.co.uk, shop.com.au. */
const SECOND_LEVEL_LABELS = /^(?:ac|co|com|edu|go|gov|ne|net|or|org)$/;
const LOGO_WORD = /logo|brand|wordmark|logotype/;

const STYLE_PROPS = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "color", "stop-color", "stop-opacity", "flood-color",
  "flood-opacity", "lighting-color", "clip-rule", "visibility", "display", "font-family", "font-size", "font-weight", "font-style",
  "letter-spacing", "text-anchor", "dominant-baseline", "paint-order", "vector-effect", "mix-blend-mode", "transform",
  "transform-origin", "transform-box", "mask", "clip-path", "filter", "marker-start", "marker-mid", "marker-end", "x", "y", "cx",
  "cy", "r", "rx", "ry",
];
const STYLE_PROP_SET = new Set(STYLE_PROPS);
const FONT_PROPS = new Set(["font-family", "font-size", "font-weight", "font-style", "letter-spacing", "text-anchor", "dominant-baseline"]);
const ROOT_SKIP = new Set(["opacity", "visibility", "display", "transform", "transform-origin", "transform-box", "mix-blend-mode", "x", "y", "filter", "clip-path", "mask"]);
const ROOT_STYLE_CLEANUP = [
  "display", "visibility", "opacity", "position", "top", "left", "right", "bottom", "inset", "margin", "transform", "translate", "rotate",
  "scale", "width", "height", "max-width", "max-height", "min-width", "min-height", "flex", "flex-shrink", "flex-grow", "vertical-align",
  "pointer-events", "cursor", "transition", "animation", "will-change", "z-index", "overflow", "contain", "inset-inline-start",
];
const DRAWABLE = "path,circle,rect,ellipse,line,polyline,polygon,text,image,use,foreignObject";
const DEFINITION_TAGS = new Set(["defs", "symbol", "style", "title", "desc", "linearGradient", "radialGradient", "pattern", "clipPath", "mask", "filter", "marker"]);
const REMOVED_ATTRIBUTES = new Set(["role", "focusable", "tabindex", "draggable", "jsaction", "jsname"]);
const CSS_PROPS: [string, FoundIn][] = [
  ["background-image", "css-background"],
  ["mask-image", "css-mask"],
  ["-webkit-mask-image", "css-mask"],
  ["-webkit-mask-box-image-source", "css-mask"],
  ["border-image-source", "css-other"],
  ["list-style-image", "css-other"],
];
const NON_IMAGE_DECLARATION = /^(?:cursor|behavior|clip-path|filter|marker(?:-start|-mid|-end)?|mask|src)$/;

// ---------------------------------------------------------------- parsers (copies of post/parse.ts)

function parseSrcset(value: string | null | undefined): { url: string; w?: number; x?: number }[] {
  const out: { url: string; w?: number; x?: number }[] = [];
  if (!value) return out;
  const s = value;
  const n = s.length;
  const space = /\s/;
  let i = 0;
  while (i < n) {
    while (i < n && (s[i] === "," || space.test(s[i]))) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !space.test(s[i])) i++;
    let url = s.slice(start, i);
    let descriptor = "";
    if (/,+$/.test(url)) {
      url = url.replace(/,+$/, "");
    } else {
      let depth = 0;
      const descriptorStart = i;
      while (i < n) {
        const c = s[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth <= 0) break;
        i++;
      }
      descriptor = s.slice(descriptorStart, i).trim();
      i++;
    }
    if (!url) continue;
    const w = descriptor.match(/(\d+)w\b/);
    const x = descriptor.match(/(\d*\.?\d+)x\b/);
    if (w) out.push({ url, w: Number(w[1]) });
    else out.push({ url, x: x ? Number(x[1]) : 1 });
  }
  return out;
}

const URL_TOKEN = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g;
const QUOTED = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
const unescapeCss = (text: string) => text.replace(/\\(.)/g, "$1");

function extractCssUrls(value: string | null | undefined): string[] {
  const out: string[] = [];
  if (!value || value === "none") return out;
  for (const match of value.matchAll(URL_TOKEN)) out.push(unescapeCss(match[1] ?? match[2] ?? match[3] ?? ""));
  if (/image-set\(/i.test(value)) {
    const rest = value.replace(URL_TOKEN, " ");
    for (const match of rest.matchAll(QUOTED)) out.push(unescapeCss(match[1] ?? match[2] ?? ""));
  }
  return [...new Set(out)].filter((url) => url && !url.startsWith("#"));
}

// ---------------------------------------------------------------- small helpers

/** SHA-1 of the UTF-8 text. `crypto.subtle` only exists on secure pages, so this is plain code. */
function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(size);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bits = bytes.length * 8;
  view.setUint32(size - 8, Math.floor(bits / 0x100000000));
  view.setUint32(size - 4, bits >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < size; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

const collapse = (text: string | null | undefined, max = 120) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const splitFamilies = (stack: string) =>
  stack
    .split(",")
    .map((family) => family.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter(Boolean);

const noContext = (): CandidateContext => ({
  header: false, nav: false, footer: false, homeLink: false, logoWord: false, siteWord: false, logoWall: false,
  shadowRoot: false, iframe: false,
});

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

// ---------------------------------------------------------------- collector

interface RootInfo {
  root: Document | ShadowRoot;
  shadow: boolean;
  iframe: boolean;
  offsetX: number;
  offsetY: number;
}

interface ElementInfo {
  context: CandidateContext;
  visible: boolean;
  rect?: Rect;
  label?: string;
  linkText?: string;
}

async function collect(options: CollectorOptions): Promise<RawCollectorOutput> {
  const T0 = performance.now();
  const outOfTime = () => performance.now() - T0 > options.timeBudgetMs;
  let truncated = false;
  const noise: Partial<Record<HiddenReason, number>> = {};
  const countNoise = (reason: HiddenReason) => {
    noise[reason] = (noise[reason] ?? 0) + 1;
  };
  const baseURI = document.baseURI;

  const abs = (value: string | null | undefined, base?: string): string | null => {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text || text.startsWith("#") || /^(?:about|javascript):/i.test(text)) return null;
    try {
      const url = new URL(text, base || baseURI);
      return /^(?:https?|data|blob):$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };

  // ------------------------------------------------ roots: document, open shadow roots, readable same-origin iframes
  const elements: Element[] = [];
  const rootOf: RootInfo[] = [];
  const indexOf = new Map<Element, number>();
  const roots: RootInfo[] = [];
  const useRefs = new Map<string, number>();

  const visitRoot = (info: RootInfo) => {
    roots.push(info);
    for (const el of info.root.querySelectorAll("*")) {
      if (elements.length >= options.maxElements) {
        truncated = true;
        return;
      }
      indexOf.set(el, elements.length);
      elements.push(el);
      rootOf.push(info);
      if (el.localName === "use") {
        const href = el.getAttribute("href") ?? el.getAttributeNS(XLINK_NS, "href") ?? "";
        const hash = href.indexOf("#");
        if (hash >= 0) useRefs.set(href.slice(hash + 1), (useRefs.get(href.slice(hash + 1)) ?? 0) + 1);
      }
      if (el.shadowRoot) visitRoot({ ...info, root: el.shadowRoot, shadow: true });
      if (el.localName === "iframe" || el.localName === "frame") {
        try {
          const frameDocument = (el as HTMLIFrameElement).contentDocument;
          if (frameDocument?.documentElement && frameDocument.location.href !== "about:blank") {
            const r = el.getBoundingClientRect();
            const view = el.ownerDocument.defaultView ?? window;
            visitRoot({
              root: frameDocument,
              shadow: false,
              iframe: true,
              offsetX: info.offsetX + r.left + view.scrollX,
              offsetY: info.offsetY + r.top + view.scrollY,
            });
          }
        } catch {
          // cross-origin
        }
      }
    }
  };
  visitRoot({ root: document, shadow: false, iframe: false, offsetX: 0, offsetY: 0 });

  // ------------------------------------------------ context, labels, visibility
  const hostname = location.hostname.replace(/^www\./, "");
  const siteTokens = new Set<string>();
  {
    const label = hostname.split(".").slice(-2, -1)[0] ?? "";
    if (label.length > 2 && !/^\d+$/.test(label)) siteTokens.add(label.toLowerCase());
    const ogSite = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
    const appName = document.querySelector('meta[name="application-name"]')?.getAttribute("content");
    for (const name of [options.siteName, ogSite, appName]) {
      const token = name?.trim().toLowerCase();
      if (token && token.length > 2 && token.length < 40) siteTokens.add(token);
    }
  }

  const composedParent = (node: Node): Element | null => {
    if (node.parentElement) return node.parentElement;
    const parent = node.parentNode;
    return parent && parent.nodeType === 11 ? ((parent as ShadowRoot).host ?? null) : null;
  };
  const composedClosest = (el: Element, selector: string): Element | null => {
    for (let node: Element | null = el; node; node = composedParent(node)) if (node.matches(selector)) return node;
    return null;
  };
  const isHomeHref = (href: string | null, base: string) => {
    if (!href) return false;
    try {
      const u = new URL(href, base);
      return u.hostname.replace(/^www\./, "") === hostname && /^\/(?:[a-z]{2}(?:[-_][a-z]{2,4})?\/?)?$/i.test(u.pathname);
    } catch {
      return false;
    }
  };
  const attributeHaystack = (el: Element) =>
    [
      typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : (el.getAttribute("class") ?? ""),
      el.id,
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("alt"),
      el.getAttribute("data-framer-name"),
      el.getAttribute("data-testid"),
      el.getAttribute("data-name"),
    ]
      .join(" ")
      .toLowerCase();

  const labelOf = (el: Element): string | undefined => {
    const link = composedClosest(el, "a[href]");
    const title = el.localName === "svg" ? el.querySelector(":scope > title")?.textContent : null;
    const framer = composedClosest(el, "[data-framer-name]");
    for (const value of [
      el.getAttribute("aria-label"),
      link?.getAttribute("aria-label"),
      title,
      el.getAttribute("alt"),
      framer?.getAttribute("data-framer-name"),
      el.getAttribute("title"),
    ]) {
      const text = collapse(value);
      if (text) return text;
    }
    return undefined;
  };

  const linkTextOf = (el: Element): string | undefined => {
    const link = composedClosest(el, "a[href]");
    if (!link) return undefined;
    let text = "";
    const walker = link.ownerDocument.createTreeWalker(link, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest("svg,script,style,noscript,template") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode(); node && text.length < 200; node = walker.nextNode()) text += ` ${node.nodeValue ?? ""}`;
    return collapse(text) || undefined;
  };

  const infoCache = new Map<Element, ElementInfo>();
  const elementInfo = (el: Element): ElementInfo => {
    const cached = infoCache.get(el);
    if (cached) return cached;
    const root = rootOf[indexOf.get(el) ?? 0];
    const view = el.ownerDocument.defaultView ?? window;
    const r = el.getBoundingClientRect();
    let visible = r.width >= 1 && r.height >= 1;
    try {
      if (visible && el.checkVisibility) visible = el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    } catch {
      // older engines
    }
    const x = Math.round(r.left + view.scrollX + root.offsetX);
    const y = Math.round(r.top + view.scrollY + root.offsetY);
    const link = composedClosest(el, "a[href]");
    let logoWord = false;
    let siteWord = false;
    let node: Element | null = el;
    for (let depth = 0; node && depth < 6; depth++, node = composedParent(node)) {
      const haystack = attributeHaystack(node);
      if (LOGO_WORD.test(haystack)) logoWord = true;
      for (const token of siteTokens) if (haystack.includes(token)) siteWord = true;
      if (node.localName === "a" || node.localName === "section" || node.localName === "header") break;
    }
    let logoWall = false;
    if (r.height >= 10 && r.height <= 140 && r.width / r.height >= 1.3) {
      let ancestor = composedParent(el);
      for (let depth = 0; ancestor && depth < 5 && !logoWall; depth++, ancestor = composedParent(ancestor)) {
        const media = ancestor.querySelectorAll("svg:not(svg svg), img");
        if (media.length > 80) break;
        if (media.length < 4) continue;
        let similar = 0;
        for (const item of media) {
          const mr = item.getBoundingClientRect();
          if (mr.height >= r.height * 0.5 && mr.height <= r.height * 2 && mr.width / Math.max(mr.height, 1) >= 1.2) similar++;
        }
        if (similar >= 4) logoWall = true;
      }
    }
    const info: ElementInfo = {
      context: {
        header: !!composedClosest(el, "header,[role=banner]"),
        nav: !!composedClosest(el, "nav,[role=navigation]"),
        footer: !!composedClosest(el, "footer,[role=contentinfo]"),
        homeLink: !!link && isHomeHref(link.getAttribute("href"), el.baseURI),
        logoWord,
        siteWord,
        logoWall,
        shadowRoot: root.shadow,
        iframe: root.iframe,
      },
      visible,
      rect: r.width > 0 && r.height > 0 ? { x, y, width: Math.round(r.width), height: Math.round(r.height) } : undefined,
      label: labelOf(el),
      linkText: link ? linkTextOf(el) : undefined,
    };
    infoCache.set(el, info);
    return info;
  };

  // ------------------------------------------------ candidates
  const candidates = new Map<string, RawCandidate>();
  let groupSeq = 0;
  const newGroup = () => ++groupSeq;

  interface CandidatePatch {
    group: number;
    descriptor?: { w?: number; x?: number };
    media?: string;
    type?: string;
    sizes?: string;
    naturalWidth?: number;
    naturalHeight?: number;
  }

  /**
   * Records a candidate found on an element. Shadow roots and iframes override `foundIn` (spec 8.1). `shown` is false
   * for URLs the element does not display (srcset alternates, lazy attributes, noscript): they keep the element's
   * context and label but not its visibility or rectangle.
   */
  const addFromElement = (el: Element, rawUrl: string | null | undefined, foundIn: FoundIn, patch: CandidatePatch, shown = true) => {
    const url = abs(rawUrl, el.baseURI);
    if (!url) return;
    const index = indexOf.get(el) ?? elements.length;
    const root = rootOf[index] ?? roots[0];
    const where: FoundIn = root?.iframe ? "iframe" : root?.shadow ? "shadow-dom" : foundIn;
    const key = `${url}|${index}|${where}|${patch.media ?? ""}`;
    const existing = candidates.get(key);
    if (existing) {
      if (patch.descriptor && !existing.descriptor) existing.descriptor = patch.descriptor;
      if (patch.naturalWidth && !existing.naturalWidth) {
        existing.naturalWidth = patch.naturalWidth;
        existing.naturalHeight = patch.naturalHeight;
      }
      return;
    }
    const info = elementInfo(el);
    candidates.set(key, {
      url,
      group: patch.group,
      foundIn: where,
      ...(patch.descriptor ? { descriptor: patch.descriptor } : {}),
      ...(patch.media ? { media: patch.media } : {}),
      ...(patch.type ? { type: patch.type } : {}),
      ...(patch.sizes ? { sizes: patch.sizes } : {}),
      order: index,
      visible: shown && info.visible,
      ...(shown && info.rect ? { rect: info.rect } : {}),
      ...(patch.naturalWidth ? { naturalWidth: patch.naturalWidth, naturalHeight: patch.naturalHeight } : {}),
      ...(info.label ? { label: info.label } : {}),
      ...(info.linkText ? { linkText: info.linkText } : {}),
      context: info.context,
      declaredOnly: false,
    });
  };

  const addDeclared = (url: string, order: number, group: number) => {
    const key = `${url}|stylesheet`;
    if (candidates.has(key)) return;
    candidates.set(key, { url, group, foundIn: "stylesheet", order, visible: false, context: noContext(), declaredOnly: true });
  };

  const addMeta = (el: Element, rawUrl: string | null | undefined, foundIn: FoundIn, patch: Partial<CandidatePatch> = {}) => {
    const url = abs(rawUrl, el.baseURI);
    if (!url) return;
    const key = `${url}|meta|${foundIn}`;
    if (candidates.has(key)) return;
    candidates.set(key, {
      url,
      group: newGroup(),
      foundIn,
      ...(patch.type ? { type: patch.type } : {}),
      ...(patch.sizes ? { sizes: patch.sizes } : {}),
      order: indexOf.get(el) ?? 0,
      visible: false,
      context: noContext(),
      declaredOnly: false,
    });
  };

  // Element sources
  for (let i = 0; i < elements.length; i++) {
    if (i % 500 === 0 && outOfTime()) {
      truncated = true;
      break;
    }
    const el = elements[i];
    const tag = el.localName;
    const isHtml = el.namespaceURI !== SVG_NS;
    try {
      if (isHtml && (tag === "img" || (tag === "input" && (el as HTMLInputElement).type === "image"))) {
        const img = el as HTMLImageElement;
        const group = newGroup();
        const picture = tag === "img" && el.parentElement?.localName === "picture" ? el.parentElement : null;
        const sources = picture
          ? [...picture.querySelectorAll("source")].flatMap((source) =>
              ["srcset", "data-srcset"].flatMap((attribute) =>
                parseSrcset(source.getAttribute(attribute)).map((c) => ({
                  url: abs(c.url, el.baseURI),
                  patch: { group, media: source.getAttribute("media") ?? undefined, type: source.getAttribute("type") ?? undefined, descriptor: c.w ? { w: c.w } : { x: c.x } },
                })),
              ),
            )
          : [];
        const current = tag === "img" ? img.currentSrc : abs(el.getAttribute("src"), el.baseURI);
        const isCurrent = (url: string | null | undefined) => !!current && abs(url, el.baseURI) === current;
        if (tag === "img" && current) {
          const natural = { naturalWidth: img.naturalWidth || undefined, naturalHeight: img.naturalHeight || undefined };
          // A current source picked from a <source> keeps that source's media, so art direction survives merging.
          const chosen = sources.find((source) => source.url === current);
          if (chosen) addFromElement(el, current, "picture", { ...chosen.patch, ...natural });
          else addFromElement(el, current, "img", { group, ...natural });
        }
        addFromElement(el, el.getAttribute("src"), "img", { group }, isCurrent(el.getAttribute("src")));
        for (const c of parseSrcset(el.getAttribute("srcset"))) addFromElement(el, c.url, "img", { group, descriptor: c.w ? { w: c.w } : { x: c.x } }, isCurrent(c.url));
        for (const attribute of el.attributes) {
          if (!LAZY_ATTR.test(attribute.name) || !attribute.value || /^\s*[{[]/.test(attribute.value)) continue;
          if (/set/i.test(attribute.name) || /\s\d+[wx]\s*(?:,|$)/.test(attribute.value)) {
            for (const c of parseSrcset(attribute.value)) addFromElement(el, c.url, "lazy-attribute", { group, descriptor: c.w ? { w: c.w } : { x: c.x } }, false);
          } else {
            addFromElement(el, attribute.value, "lazy-attribute", { group }, false);
          }
        }
        for (const source of sources) addFromElement(el, source.url, "picture", source.patch, source.url === current);
      } else if (isHtml && tag === "video") {
        addFromElement(el, el.getAttribute("poster") ?? el.getAttribute("data-poster"), "video-poster", { group: newGroup() });
      } else if (!isHtml && tag === "image") {
        addFromElement(el, el.getAttribute("href") ?? el.getAttributeNS(XLINK_NS, "href"), "svg-image", { group: newGroup() });
      } else if (isHtml && (tag === "object" || tag === "embed" || tag === "iframe")) {
        const value = el.getAttribute(tag === "object" ? "data" : "src");
        const type = el.getAttribute("type") ?? "";
        const svgOrImage = tag === "iframe" ? /\.svg(?:[?#]|$)/i.test(value ?? "") : /svg|image/i.test(type) || /\.(?:svg|png|jpe?g|gif|webp)(?:[?#]|$)/i.test(value ?? "");
        if (value && svgOrImage) addFromElement(el, value, "object-embed", { group: newGroup() });
      } else if (isHtml && tag === "noscript") {
        const parsed = new DOMParser().parseFromString(el.textContent || el.innerHTML, "text/html");
        for (const item of parsed.querySelectorAll("img,source")) {
          const group = newGroup();
          addFromElement(el, abs(item.getAttribute("src"), el.baseURI), "noscript", { group }, false);
          for (const c of parseSrcset(item.getAttribute("srcset"))) {
            addFromElement(el, abs(c.url, el.baseURI), "noscript", { group, descriptor: c.w ? { w: c.w } : { x: c.x } }, false);
          }
        }
      } else if (!/^(?:script|style|link|meta|source|picture)$/.test(tag)) {
        for (const attribute of el.attributes) {
          if (LAZY_BACKGROUND_ATTR.test(attribute.name) && attribute.value && !/^\s*[{[]/.test(attribute.value)) {
            addFromElement(el, extractCssUrls(attribute.value)[0] ?? attribute.value, "lazy-attribute", { group: newGroup() }, false);
          }
        }
      }
    } catch {
      // one broken element never stops the walk
    }
  }

  // Computed CSS images, including ::before and ::after
  for (let i = 0; i < elements.length; i++) {
    if (i % 250 === 0 && outOfTime()) {
      truncated = true;
      break;
    }
    const el = elements[i];
    if (el.namespaceURI === SVG_NS && el.localName !== "svg") continue;
    const view = el.ownerDocument.defaultView ?? window;
    for (const pseudo of [null, "::before", "::after"]) {
      let style: CSSStyleDeclaration;
      try {
        style = view.getComputedStyle(el, pseudo);
      } catch {
        continue;
      }
      if (pseudo) {
        const content = style.getPropertyValue("content");
        const empty = (value: string) => !value || value === "none";
        if ((empty(content) || content === "normal") && empty(style.getPropertyValue("background-image")) && empty(style.getPropertyValue("mask-image")) && empty(style.getPropertyValue("-webkit-mask-image"))) {
          continue;
        }
      }
      const properties: [string, FoundIn][] = pseudo ? [...CSS_PROPS, ["content", "css-pseudo"]] : CSS_PROPS;
      for (const [property, where] of properties) {
        const value = style.getPropertyValue(property);
        if (!value || value === "none" || !/url\(|image-set\(/i.test(value)) continue;
        const setGroup = /image-set\(/i.test(value) ? newGroup() : 0;
        for (const url of extractCssUrls(value)) addFromElement(el, url, pseudo ? "css-pseudo" : where, { group: setGroup || newGroup() });
      }
    }
  }

  // Stylesheets through CSSOM: declared url() and @font-face
  const fontFaces: RawFontFaceRule[] = [];
  const unreadableSheets: string[] = [];
  {
    let declaredOrder = elements.length;
    const seenSheets = new Set<CSSStyleSheet>();
    const walkRules = (rules: CSSRuleList, base: string) => {
      for (const rule of rules) {
        try {
          if (rule.type === 3) {
            walkSheet((rule as CSSImportRule).styleSheet, base);
            continue;
          }
          if (rule.type === 5) {
            const style = (rule as CSSFontFaceRule).style;
            fontFaces.push({
              family: style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, ""),
              src: parseFontSrc(style.getPropertyValue("src"), base),
              weight: style.getPropertyValue("font-weight") || "normal",
              style: style.getPropertyValue("font-style") || "normal",
              ...(style.getPropertyValue("font-stretch") ? { stretch: style.getPropertyValue("font-stretch") } : {}),
              ...(style.getPropertyValue("unicode-range") ? { unicodeRange: style.getPropertyValue("unicode-range") } : {}),
              baseUrl: base,
              origin: "cssom",
            });
            continue;
          }
          const style = (rule as CSSStyleRule).style;
          if (style && /url\(|image-set\(/i.test(style.cssText)) {
            for (let k = 0; k < style.length; k++) {
              const property = style[k];
              if (NON_IMAGE_DECLARATION.test(property)) continue;
              const value = style.getPropertyValue(property);
              const setGroup = /image-set\(/i.test(value) ? newGroup() : 0;
              for (const raw of extractCssUrls(value)) {
                const url = abs(raw, base);
                if (url) addDeclared(url, declaredOrder++, setGroup || newGroup());
              }
            }
          }
          const nested = (rule as CSSGroupingRule).cssRules;
          if (nested?.length) walkRules(nested, base);
        } catch {
          // unreadable rule
        }
      }
    };
    const walkSheet = (sheet: CSSStyleSheet | null, fallbackBase: string) => {
      if (!sheet || seenSheets.has(sheet)) return;
      seenSheets.add(sheet);
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        if (sheet.href) unreadableSheets.push(sheet.href);
        return;
      }
      walkRules(rules, sheet.href ?? sheet.ownerNode?.baseURI ?? fallbackBase);
    };
    for (const { root } of roots) {
      const base = (root as Document).baseURI ?? (root as ShadowRoot).host?.baseURI ?? baseURI;
      for (const sheet of root.styleSheets) walkSheet(sheet, base);
      for (const sheet of root.adoptedStyleSheets ?? []) walkSheet(sheet, base);
    }
  }

  // Icons, social images, JSON-LD logos, manifest
  let manifestUrl: string | undefined;
  for (const link of document.querySelectorAll("link[rel][href]")) {
    const rel = ` ${(link.getAttribute("rel") ?? "").toLowerCase()} `;
    const href = link.getAttribute("href");
    if (/\s(?:icon|shortcut|apple-touch-icon|apple-touch-icon-precomposed|mask-icon|fluid-icon)\s/.test(rel)) {
      addMeta(link, href, "icon-link", { type: link.getAttribute("type") ?? undefined, sizes: link.getAttribute("sizes") ?? undefined });
    } else if (/\simage_src\s/.test(rel)) {
      addMeta(link, href, "og-image");
    } else if (/\smanifest\s/.test(rel) && !manifestUrl) {
      manifestUrl = abs(href, link.baseURI) ?? undefined;
    }
  }
  for (const meta of document.querySelectorAll("meta[content]")) {
    const key = (meta.getAttribute("property") ?? meta.getAttribute("name") ?? meta.getAttribute("itemprop") ?? "").toLowerCase();
    const content = meta.getAttribute("content");
    if (/^og:image(?::url|:secure_url)?$|^image$|^thumbnail$/.test(key)) addMeta(meta, content, "og-image");
    else if (/^twitter:image(?::src)?$/.test(key)) addMeta(meta, content, "twitter-image");
    else if (key === "msapplication-tileimage") addMeta(meta, content, "icon-link");
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (value: unknown, depth: number) => {
        if (!value || typeof value !== "object" || depth > 6) return;
        if (Array.isArray(value)) {
          for (const item of value) walk(item, depth + 1);
          return;
        }
        for (const [key, item] of Object.entries(value)) {
          if (key === "logo") {
            const url = typeof item === "string" ? item : ((item as { url?: unknown })?.url ?? (item as { contentUrl?: unknown })?.contentUrl);
            if (typeof url === "string") addMeta(script, url, "json-ld");
          } else if (item && typeof item === "object") {
            walk(item, depth + 1);
          }
        }
      };
      walk(JSON.parse(script.textContent ?? ""), 0);
    } catch {
      // invalid JSON-LD
    }
  }

  // ------------------------------------------------ fonts
  const fontStatuses: RawFontStatus[] = [];
  const loadedFamilies = new Set<string>();
  for (const face of document.fonts) {
    const family = face.family.replace(/^["']|["']$/g, "");
    fontStatuses.push({ family, weight: face.weight, style: face.style, stretch: face.stretch, status: face.status });
    if (face.status === "loaded") loadedFamilies.add(family.toLowerCase());
  }
  const usage = new Map<string, RawFontUsage>();
  {
    let textNodes = 0;
    for (const { root } of roots) {
      if (textNodes >= MAX_TEXT_NODES || outOfTime()) break;
      const start = (root as Document).body ?? root;
      const owner = (root as Document).createTreeWalker ? (root as Document) : root.ownerDocument;
      if (!start || !owner) continue;
      const walker = owner.createTreeWalker(start, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && textNodes < MAX_TEXT_NODES; node = walker.nextNode()) {
        const text = node.nodeValue?.trim();
        const parent = node.parentElement;
        if (!text || !parent || /^(?:script|style|noscript|template)$/.test(parent.localName)) continue;
        textNodes++;
        try {
          if (parent.checkVisibility && !parent.checkVisibility({ visibilityProperty: true })) continue;
        } catch {
          // keep it
        }
        const style = (parent.ownerDocument.defaultView ?? window).getComputedStyle(parent);
        const key = `${style.fontFamily}|${style.fontWeight}|${style.fontStyle}`;
        const entry = usage.get(key) ?? { stack: style.fontFamily, weight: style.fontWeight, style: style.fontStyle, chars: 0 };
        entry.chars += text.length;
        usage.set(key, entry);
      }
    }
  }

  // ------------------------------------------------ inline SVG
  const svgs = new Map<string, RawSvg>();
  let svgTotalBytes = 0;
  let sandbox: { frame: HTMLIFrameElement; doc: Document; view: Window } | null = null;
  const getSandbox = () => {
    if (sandbox) return sandbox;
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;left:-100000px;top:0;width:1200px;height:1200px;border:0;pointer-events:none;";
    document.documentElement.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write("<!doctype html><html><head></head><body></body></html>");
    doc.close();
    sandbox = { frame, doc, view: frame.contentWindow! };
    return sandbox;
  };
  const spriteCache = new Map<string, Promise<Document | null>>();
  const fetchSprite = (url: string) => {
    let pending = spriteCache.get(url);
    if (!pending) {
      pending = (async () => {
        const remaining = options.timeBudgetMs - (performance.now() - T0);
        if (remaining <= 0) return null;
        try {
          const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(Math.min(options.spriteFetchMs, remaining)) });
          if (!response.ok) return null;
          return new DOMParser().parseFromString(await response.text(), "image/svg+xml");
        } catch {
          return null;
        }
      })();
      spriteCache.set(url, pending);
    }
    return pending;
  };
  const referencedIds = (el: Element) => {
    const ids = new Set<string>();
    const scan = (value: string | null) => {
      if (!value) return;
      for (const match of value.matchAll(/url\(\s*["']?#([^"')\s]+)["']?\s*\)/g)) ids.add(match[1]);
    };
    for (const node of [el, ...el.querySelectorAll("*")]) {
      for (const attribute of node.attributes) {
        if (attribute.localName === "href" && attribute.value.startsWith("#")) ids.add(attribute.value.slice(1));
        else if (attribute.value.includes("url(")) scan(attribute.value);
      }
      if (node.localName === "style") scan(node.textContent);
    }
    return ids;
  };
  const cssEscape = (value: string) => CSS.escape(value);
  const hasWebFontText = (svg: Element) => {
    const view = svg.ownerDocument.defaultView ?? window;
    for (const text of svg.querySelectorAll("text,tspan,textPath")) {
      if (splitFamilies(view.getComputedStyle(text).fontFamily).some((family) => loadedFamilies.has(family))) return true;
    }
    return false;
  };

  /** Normalizes one top-level SVG so the standalone file looks like the page (spec 8.6). */
  const normalizeSvg = async (svg: SVGSVGElement) => {
    const view = svg.ownerDocument.defaultView ?? window;
    const rect = svg.getBoundingClientRect();
    const liveElements = [svg, ...svg.querySelectorAll("*")];
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const cloneElements = [clone, ...clone.querySelectorAll("*")];

    // References: external sprites, then local ids, into one <defs>
    const scope = svg.getRootNode() as Document | ShadowRoot;
    const lookup = (id: string) => {
      try {
        return scope.getElementById ? scope.getElementById(id) : (scope as ParentNode).querySelector(`#${cssEscape(id)}`);
      } catch {
        return null;
      }
    };
    let defs: SVGDefsElement | null = null;
    const ensureDefs = () => {
      if (!defs) {
        defs = clone.ownerDocument.createElementNS(SVG_NS, "defs") as SVGDefsElement;
        clone.insertBefore(defs, clone.firstChild);
      }
      return defs;
    };
    for (const use of clone.querySelectorAll("use")) {
      const href = use.getAttribute("href") ?? use.getAttributeNS(XLINK_NS, "href");
      if (!href || href.startsWith("#")) continue;
      const url = abs(href, svg.baseURI);
      const [file, id] = url ? url.split("#") : [];
      if (!file || !id || !/^https?:/.test(file)) continue;
      const target = (await fetchSprite(file))?.getElementById(id);
      if (!target) continue;
      if (!clone.querySelector(`#${cssEscape(id)}`)) ensureDefs().appendChild(clone.ownerDocument.importNode(target, true));
      use.removeAttributeNS(XLINK_NS, "href");
      use.setAttribute("href", `#${id}`);
    }
    for (let pass = 0; pass < 4; pass++) {
      let added = 0;
      for (const id of referencedIds(clone)) {
        if (clone.querySelector(`#${cssEscape(id)}`)) continue;
        const target = lookup(id);
        if (!target || svg.contains(target)) continue;
        const copy = target.cloneNode(true) as Element;
        const originals = [target, ...target.querySelectorAll("*")];
        const copies = [copy, ...copy.querySelectorAll("*")];
        originals.forEach((original, k) => {
          for (const attribute of original.attributes) {
            if (!attribute.value.includes("var(") || !STYLE_PROP_SET.has(attribute.name)) continue;
            const value = view.getComputedStyle(original).getPropertyValue(attribute.name);
            if (value) copies[k].setAttribute(attribute.name, value);
          }
        });
        ensureDefs().appendChild(copy);
        added++;
      }
      if (!added) break;
    }

    // Computed styles that differ from a neutral rendering, top-down
    const hasText = !!svg.querySelector("text,tspan,textPath");
    const usesCurrentColor = /currentcolor/i.test(clone.outerHTML);
    if (liveElements.length <= MAX_STYLED_SVG_ELEMENTS) {
      const box = getSandbox();
      const imported = box.doc.importNode(clone, true);
      box.doc.body.appendChild(imported);
      const sandboxElements = [imported, ...imported.querySelectorAll("*")];
      const definitionCount = defs ? 1 + (defs as SVGDefsElement).querySelectorAll("*").length : 0;
      for (let i = 0; i < liveElements.length; i++) {
        const live = liveElements[i];
        const neutral = sandboxElements[i === 0 ? 0 : i + definitionCount] as SVGElement | undefined;
        const out = cloneElements[i] as SVGElement | undefined;
        if (!neutral || !out || neutral.localName !== live.localName) continue;
        const forced = new Set<string>();
        for (const attribute of live.attributes) if (attribute.value.includes("var(") && STYLE_PROP_SET.has(attribute.name)) forced.add(attribute.name);
        const inline = (live as SVGElement).style;
        if (inline) {
          for (const property of inline) {
            if (!property.startsWith("--") && STYLE_PROP_SET.has(property) && inline.getPropertyValue(property).includes("var(")) forced.add(property);
          }
        }
        const liveStyle = view.getComputedStyle(live);
        const neutralStyle = box.view.getComputedStyle(neutral);
        const declarations: [string, string][] = [];
        for (const property of STYLE_PROPS) {
          if (i === 0 && ROOT_SKIP.has(property)) continue;
          if (!hasText && FONT_PROPS.has(property)) continue;
          if (property === "color" && !usesCurrentColor) continue;
          const value = liveStyle.getPropertyValue(property);
          if (value === "") continue;
          if (forced.has(property)) {
            declarations.push([property, value]);
          } else if (value !== neutralStyle.getPropertyValue(property)) {
            if ((property === "transform" || property === "transform-origin") && liveStyle.getPropertyValue("transform") === "none") continue;
            declarations.push([property, value]);
          }
        }
        for (const [property, value] of declarations) {
          neutral.style.setProperty(property, value);
          out.style.setProperty(property, value);
        }
      }
      imported.remove();
    }

    // Root attributes
    clone.setAttribute("xmlns", SVG_NS);
    const numeric = (name: string) => {
      const value = svg.getAttribute(name);
      return value && /^\s*[\d.]+(?:px)?\s*$/.test(value) ? parseFloat(value) : null;
    };
    if (!svg.getAttribute("viewBox")) {
      const width = numeric("width");
      const height = numeric("height");
      if (width && height) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
      else if (rect.width > 0 && rect.height > 0) clone.setAttribute("viewBox", `0 0 ${+rect.width.toFixed(2)} ${+rect.height.toFixed(2)}`);
      else {
        try {
          const box = svg.getBBox();
          if (box.width && box.height) clone.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
        } catch {
          // not rendered
        }
      }
    }
    if (rect.width > 0 && rect.height > 0) {
      clone.setAttribute("width", String(+rect.width.toFixed(2)));
      clone.setAttribute("height", String(+rect.height.toFixed(2)));
    } else if (!numeric("width")) {
      const box = (clone.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
      if (box.length === 4 && box[2] > 0 && box[3] > 0) {
        clone.setAttribute("width", String(box[2]));
        clone.setAttribute("height", String(box[3]));
      }
    }

    // Cleanup
    for (const property of ROOT_STYLE_CLEANUP) clone.style.removeProperty(property);
    if (clone.getAttribute("visibility") === "hidden") clone.removeAttribute("visibility");
    if (clone.getAttribute("display") === "none") clone.removeAttribute("display");
    const hasInnerStyle = !!clone.querySelector("style");
    for (const node of [clone, ...clone.querySelectorAll("*")]) {
      if (node.localName === "script") {
        node.remove();
        continue;
      }
      for (const attribute of [...node.attributes]) {
        const name = attribute.name;
        if (/^on/i.test(name) || name.startsWith("data-") || name.startsWith("aria-") || REMOVED_ATTRIBUTES.has(name)) {
          node.removeAttribute(name);
        } else if (name === "class") {
          if (!hasInnerStyle) node.removeAttribute(name);
        } else if (name === "style") {
          const style = (node as SVGElement).style;
          for (const property of [...style]) if (property.startsWith("--") || style.getPropertyValue(property).includes("var(")) style.removeProperty(property);
          if (!node.getAttribute("style")?.trim()) node.removeAttribute("style");
        } else if (attribute.value.includes("var(") && name !== "d") {
          const fallback = attribute.value.replace(/var\(\s*--[\w-]+\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_, value?: string) => (value ?? "").trim()).trim();
          if (fallback && !fallback.includes("var(")) node.setAttribute(name, fallback);
          else node.removeAttribute(name);
        } else if ((attribute.localName === "href") && !attribute.value.startsWith("#") && !attribute.value.startsWith("data:")) {
          const url = abs(attribute.value, svg.baseURI);
          if (url && /^https?:/.test(url)) attribute.value = url;
          else node.removeAttributeNode(attribute);
        }
      }
    }

    // Serialize, then hash a canonical form: ids renamed in order of appearance, whitespace collapsed
    const markup = new XMLSerializer().serializeToString(clone);
    let canonical = markup;
    let next = 0;
    const ids = new Map<string, string>();
    for (const match of markup.matchAll(/\sid="([^"]+)"/g)) if (!ids.has(match[1])) ids.set(match[1], `i${next++}`);
    for (const [id, replacement] of ids) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      canonical = canonical.replace(new RegExp(`(id="|#)${escaped}(?=["')\\s])`, "g"), `$1${replacement}`);
    }
    canonical = canonical.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ");
    return { markup, hash: sha1Hex(canonical), elementCount: liveElements.length, hasLiveText: hasText && hasWebFontText(svg) };
  };

  const addSvg = (entry: RawSvg) => {
    const existing = svgs.get(entry.hash);
    if (existing) {
      existing.usedCount += entry.usedCount;
      existing.visible ||= entry.visible;
      if (entry.rect && (!existing.rect || entry.rect.width * entry.rect.height > existing.rect.width * existing.rect.height)) existing.rect = entry.rect;
      existing.label ??= entry.label;
      existing.linkText ??= entry.linkText;
      existing.order = Math.min(existing.order, entry.order);
      for (const key of Object.keys(existing.context) as (keyof CandidateContext)[]) existing.context[key] ||= entry.context[key];
      return true;
    }
    const bytes = byteLength(entry.markup);
    if (bytes > options.maxSvgBytes) {
      countNoise("svg-too-large");
      return false;
    }
    if (svgTotalBytes + bytes > options.maxSvgTotalBytes) {
      truncated = true;
      return false;
    }
    svgTotalBytes += bytes;
    svgs.set(entry.hash, entry);
    return true;
  };

  {
    const rawHashes = new Map<string, { hash: string; count: number }>();
    let normalizations = 0;
    for (const el of elements) {
      if (el.localName !== "svg" || el.namespaceURI !== SVG_NS || el.parentElement?.closest("svg")) continue;
      if (outOfTime()) {
        truncated = true;
        break;
      }
      const svg = el as SVGSVGElement;
      try {
        if (svg.querySelector('[id^="__lottie_element"]') || svg.closest('[class*="lottie" i]')) {
          countNoise("lottie-frame");
          continue;
        }
        const order = indexOf.get(svg) ?? 0;
        const onlyDefinitions = !svg.querySelector(DRAWABLE) || [...svg.children].every((child) => DEFINITION_TAGS.has(child.localName));
        if (onlyDefinitions) {
          for (const symbol of svg.querySelectorAll("symbol[id]")) {
            const uses = useRefs.get(symbol.id) ?? 0;
            if (!uses) {
              countNoise("unreferenced-symbol");
              continue;
            }
            const standalone = document.createElementNS(SVG_NS, "svg");
            standalone.setAttribute("xmlns", SVG_NS);
            const viewBox = symbol.getAttribute("viewBox");
            if (viewBox) standalone.setAttribute("viewBox", viewBox);
            for (const child of symbol.childNodes) standalone.appendChild(child.cloneNode(true));
            for (const script of standalone.querySelectorAll("script")) script.remove();
            const markup = new XMLSerializer().serializeToString(standalone);
            addSvg({
              markup,
              hash: sha1Hex(markup.replace(/>\s+</g, "><")),
              source: "sprite-symbol",
              referenced: true,
              order: indexOf.get(symbol) ?? order,
              visible: false,
              label: collapse(symbol.querySelector(":scope > title")?.textContent) || collapse(symbol.getAttribute("aria-label")) || symbol.id,
              context: { ...noContext(), shadowRoot: rootOf[order]?.shadow ?? false, iframe: rootOf[order]?.iframe ?? false },
              usedCount: uses,
              hasLiveText: false,
              elementCount: 1 + symbol.querySelectorAll("*").length,
            });
          }
          continue;
        }
        const raw = svg.outerHTML;
        if (raw.length > options.maxSvgBytes * 4) {
          countNoise("svg-too-large");
          continue;
        }
        const info = elementInfo(svg);
        const seen = rawHashes.get(raw);
        const base = { source: "inline" as const, referenced: true, order, visible: info.visible, label: info.label, linkText: info.linkText, context: { ...info.context }, usedCount: 1 };
        if (seen && seen.count >= MAX_SAME_MARKUP_NORMALIZATIONS) {
          const existing = svgs.get(seen.hash);
          if (existing) addSvg({ ...existing, ...base, markup: existing.markup, hash: seen.hash, rect: info.rect, hasLiveText: existing.hasLiveText, elementCount: existing.elementCount });
          continue;
        }
        if (normalizations >= options.maxSvgNormalizations) {
          truncated = true;
          continue;
        }
        normalizations++;
        const normalized = await normalizeSvg(svg);
        rawHashes.set(raw, { hash: normalized.hash, count: (seen?.count ?? 0) + 1 });
        addSvg({ ...base, ...normalized, ...(info.rect ? { rect: info.rect } : {}) });
      } catch {
        // one broken SVG never stops the collector
      }
    }
    (sandbox as { frame: HTMLIFrameElement } | null)?.frame.remove();
  }

  // ------------------------------------------------ blob: bytes while the page is alive
  const blobs: RawCollectorOutput["blobs"] = [];
  {
    let total = 0;
    const blobUrls = [...new Set([...candidates.values()].map((c) => c.url).filter((url) => url.startsWith("blob:")))];
    for (const url of blobUrls) {
      if (outOfTime()) {
        truncated = true;
        break;
      }
      let entry: { mime: string; bytes: Uint8Array } | null = null;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(BLOB_FETCH_MS) });
        const blob = await response.blob();
        if (blob.size <= options.maxBlobBytes) entry = { mime: blob.type || "application/octet-stream", bytes: new Uint8Array(await blob.arrayBuffer()) };
      } catch {
        // revoked: re-encode the decoded image through a canvas (a same-origin blob does not taint it)
        const img = elements.find((el) => el.localName === "img" && (el as HTMLImageElement).currentSrc === url) as HTMLImageElement | undefined;
        if (img?.complete && img.naturalWidth > 0) {
          try {
            const canvas = img.ownerDocument.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext("2d")?.drawImage(img, 0, 0);
            const base64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
            const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
            if (bytes.length <= options.maxBlobBytes) entry = { mime: "image/png", bytes };
          } catch {
            // tainted or too large for a canvas
          }
        }
      }
      if (!entry) continue;
      if (total + entry.bytes.length > options.maxBlobTotalBytes) {
        truncated = true;
        continue;
      }
      total += entry.bytes.length;
      blobs.push({ url, mime: entry.mime, base64: bytesToBase64(entry.bytes) });
    }
  }

  // ------------------------------------------------ brand resource links
  const brandLinks: RawCollectorOutput["brandLinks"] = [];
  {
    /** Registrable domain approximation: the last two labels, or three under a `co.uk`-like suffix. */
    const siteOf = (host: string) => {
      const bare = host.replace(/^www\./, "").toLowerCase();
      if (/^[\d.]+$|^\[|^localhost$/.test(bare)) return bare;
      const labels = bare.split(".");
      const take = labels.length > 2 && labels[labels.length - 1].length === 2 && SECOND_LEVEL_LABELS.test(labels[labels.length - 2]) ? 3 : 2;
      return labels.slice(-take).join(".");
    };
    const site = siteOf(location.hostname);
    const current = location.href.split("#")[0];
    const seen = new Set<string>();
    for (const el of elements) {
      if (brandLinks.length >= options.maxBrandLinks) break;
      if (el.localName !== "a" || !el.hasAttribute("href")) continue;
      const href = abs(el.getAttribute("href"), el.baseURI);
      if (!href || !/^https?:/.test(href)) continue;
      const url = new URL(href);
      url.hash = "";
      if (siteOf(url.hostname) !== site || url.href === current || seen.has(url.href)) continue;
      const text = collapse(el.textContent, 80) || collapse(el.getAttribute("aria-label"), 80) || collapse(el.getAttribute("title"), 80);
      if (!isBrandLink(decodeURIComponentSafe(url.pathname + url.search)) && !isBrandLink(text)) continue;
      seen.add(url.href);
      brandLinks.push({ href: url.href, text });
    }
  }

  const title = document.title;
  const siteName =
    document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim() ||
    document.querySelector('meta[name="application-name"]')?.getAttribute("content")?.trim() ||
    undefined;

  return {
    page: { title, ...(siteName ? { siteName } : {}), baseUrl: baseURI, elementCount: document.getElementsByTagName("*").length },
    candidates: [...candidates.values()],
    svgs: [...svgs.values()],
    ...(manifestUrl ? { manifestUrl } : {}),
    fontFaces,
    fontStatuses,
    fontUsage: [...usage.values()].sort((a, b) => b.chars - a.chars),
    unreadableSheets: [...new Set(unreadableSheets)],
    blobs,
    brandLinks,
    noise,
    stats: { elements: elements.length, ms: Math.round(performance.now() - T0), truncated },
  };
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** `@font-face` `src` descriptors: `url()` with its `format()` hint, or `local()`. */
function parseFontSrc(src: string, base: string): RawFontFaceRule["src"] {
  const out: RawFontFaceRule["src"] = [];
  const pattern = /(url|local)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?(?:\s*tech\([^)]*\))?/g;
  for (const match of src.matchAll(pattern)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (match[1] === "local") {
      if (value) out.push({ local: value });
      continue;
    }
    try {
      const url = new URL(value, base).href;
      out.push(match[5] ? { url, format: match[5].trim().toLowerCase() } : { url });
    } catch {
      // not a URL
    }
  }
  return out;
}

globalThis.__assetsScraper = { collect };
