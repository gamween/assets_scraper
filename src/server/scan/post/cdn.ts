/**
 * CDN "original URL" rules (spec 8.4), ported from the discovery lab (`lib/cdn.mjs`).
 *
 * `originalCandidates` returns rewrites of an observed image URL, most unwrapped first. Every rule is a pure URL
 * rewrite: callers verify a candidate before using it, and the observed URL is always the fallback, so it is never in
 * the list.
 */

export interface CdnHints {
  pageUrl?: string;
  server?: string;          // `Server` response header of the observed URL (Cloudinary, imgix, Contentful on custom domains)
}

type Confidence = "high" | "medium" | "low";
interface Rewrite { href: string; confidence: Confidence }

const IMG_EXT = "(?:jpe?g|png|gif|webp|avif|svg|bmp|tiff?|heic)";
const MAX_DEPTH = 3;
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

const IMGIX_PARAMS = [
  "w", "h", "q", "fit", "crop", "auto", "fm", "dpr", "cs", "ixlib", "rect", "ar", "max-w", "max-h", "min-w", "min-h", "bg",
  "pad", "blur", "sharp", "lossless", "ch", "orient", "trim", "fp-x", "fp-y", "fp-z", "fp-debug", "txt", "mark", "exp", "bri",
  "con", "sat", "vib", "usm", "usmrad", "nr", "nrs", "faceindex", "facepad", "or", "flip", "rot", "format", "width", "height",
  "quality",
];
const WORDPRESS_PARAMS = ["w", "h", "resize", "fit", "crop", "quality", "strip", "zoom", "lb"];
/**
 * Query parameters that only ask an image CDN for a transformed rendering of a file the path already names. A query
 * built from these alone can be dropped to ask for the file itself. Version and cache-busting keys are deliberately
 * out: dropping those changes nothing, and would only spend a probe. `url`-style keys are out too, since there the
 * query carries the source and the path is the transformer.
 */
const TRANSFORM_ONLY_PARAMS = new Set([
  ...IMGIX_PARAMS, "imwidth", "resize", "scale-down-to", "strip", "zoom", "compress", "progressive",
]);
/** Query parameters that only change how an image is rendered, removed from variant keys (spec 8.3). */
const PRESENTATIONAL_PARAMS = [
  "w", "width", "h", "height", "q", "quality", "fm", "format", "auto", "fit", "dpr", "crop", "scale-down-to", "lossless",
  "imwidth", "v", "ver", "version", "cache", "cb",
];

const tryUrl = (value: string | null | undefined, base?: string): URL | null => {
  if (value == null) return null;
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
};

const withoutParams = (u: URL, names: string[]): string => {
  const x = new URL(u.href);
  for (const name of names) x.searchParams.delete(name);
  return x.href.replace(/\?$/, "");
};

const withoutQuery = (u: URL): string => {
  const x = new URL(u.href);
  x.search = "";
  return x.href;
};

const decodeBase64Url = (value: string): string | null => {
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
};

function oneStep(u: URL, hints: CdnHints, depth: number): Rewrite[] {
  const out: Rewrite[] = [];
  const push = (href: string | null | undefined, confidence: Confidence = "high") => {
    const target = tryUrl(href);
    if (!target || target.href === u.href || !/^https?:$/.test(target.protocol)) return;
    out.push({ href: target.href, confidence });
  };
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const sp = u.searchParams;
  const server = (hints.server ?? "").toLowerCase();

  // Framework image optimizers carry the source in a query parameter, under any base path.
  if (/\/_next\/image\/?$/.test(path) && sp.get("url")) push(tryUrl(sp.get("url"), u.origin)?.href);
  if (/\/_vercel\/image\/?$/.test(path) && sp.get("url")) push(tryUrl(sp.get("url"), u.origin)?.href);
  if (/\/\.netlify\/images\/?$/.test(path) && sp.get("url")) push(tryUrl(sp.get("url"), u.origin)?.href);
  if (/\/_image\/?$/.test(path) && sp.get("href")) push(tryUrl(sp.get("href"), u.origin)?.href);

  // Nuxt Image / IPX: /_ipx/<modifiers>/<source>, or a dedicated ipx.* host. "_" means no modifiers.
  {
    const m = path.match(/^(.*?\/_ipx)\/([^/]+)\/(.+)$/) ?? (/^ipx\./.test(host) ? path.match(/^()\/([^/]+)\/(.+)$/) : null);
    if (m && m[2] !== "_") push(`${u.origin}${m[1]}/_/${m[3]}`);
  }

  // Cloudflare Image Resizing: /cdn-cgi/image/<options>/<source>
  {
    const m = path.match(/^\/cdn-cgi\/image\/[^/]+\/(.+)$/);
    if (m) {
      const source = m[1];
      push(/^https?:\/?\/?/.test(source) ? source.replace(/^(https?):\/(?!\/)/, "$1://") + u.search : tryUrl(`/${source}${u.search}`, u.origin)?.href);
    }
  }

  // Gatsby Image CDN: /_gatsby/image/<hash>/<hash>/<file>?u=<source>&a=<args>
  if (/\/_gatsby\/image\//.test(path)) {
    const source = sp.get("u");
    if (source && /^https?:\/\//.test(source)) push(source);
    else {
      const segment = path.match(/\/_gatsby\/image\/([^/]+)\//)?.[1];
      const decoded = segment ? decodeBase64Url(segment) : null;
      if (decoded && /^https?:\/\//.test(decoded)) push(decoded, "medium");
    }
  }

  // Framer
  if (host === "framerusercontent.com" && /^\/images\//.test(path) && u.search) push(withoutQuery(u));

  // Webflow responsive variants: <name>-p-500.<ext>
  if (/(^|\.)website-files\.com$|(^|\.)webflow\.com$/.test(host)) {
    const m = path.match(new RegExp(`^(.*)-p-(\\d{3,4})(\\.${IMG_EXT})$`, "i"));
    if (m) push(u.origin + m[1] + m[3]);
  }

  // Wix
  if (host === "static.wixstatic.com") {
    const m = path.match(/^(\/media\/[^/]+)\/v1\/(fill|fit|crop)\/.+$/);
    if (m) push(u.origin + m[1], m[2] === "crop" ? "medium" : "high");
  }

  // Shopify (cdn.shopify.com and storefront /cdn/shop/)
  if (host === "cdn.shopify.com" || /^\/cdn\/shop\//.test(path)) {
    let changed = false;
    const x = new URL(u.href);
    for (const key of ["width", "height", "crop", "pad_color", "format"]) {
      if (x.searchParams.has(key)) {
        x.searchParams.delete(key);
        changed = true;
      }
    }
    const suffix = new RegExp(
      `_(?:pico|icon|thumb|small|compact|medium|large|grande|original|master|\\d+x\\d*|\\d*x\\d+)(?:_crop_(?:top|center|bottom|left|right))?(?:@[23]x)?(\\.${IMG_EXT})$`,
      "i",
    );
    const hasSuffix = suffix.test(x.pathname);
    if (hasSuffix) {
      x.pathname = x.pathname.replace(suffix, "$1");
      changed = true;
    }
    if (changed) push(x.href, hasSuffix ? "medium" : "high");
  }

  // Squarespace: rebuild the query, the markup often carries malformed ones ("?content-type=image%2Fjpeg?format=500w").
  // Measured: ?format=2500w returns the JPEG master where ?format=original returned a smaller WebP.
  if (host === "images.squarespace-cdn.com" || (/(^|\.)squarespace\.com$/.test(host) && /^\/static\//.test(path))) {
    push(`${u.origin}${u.pathname}?format=2500w`);
  }

  // Cloudinary (res.cloudinary.com, or a custom domain detected by the Server header). Signed URLs are skipped.
  if (host === "res.cloudinary.com" || server.includes("cloudinary")) {
    const m = path.match(/^(\/[^/]+)?\/(image|video)\/(upload|fetch|private)\/(.+)$/);
    if (m && !/\/s--[A-Za-z0-9_-]{8}--\//.test(path)) {
      const prefix = `${m[1] ?? ""}/${m[2]}/${m[3]}/`;
      const segments = m[4].split("/");
      const isTransform = (s: string) => /^(?:[a-z]{1,3}_[^,/]+)(?:,[a-z]{1,3}_[^,/]+)*$/.test(s) && !/^v\d+$/.test(s);
      let i = 0;
      while (i < segments.length - 1 && isTransform(segments[i])) i++;
      if (m[3] === "fetch") {
        let rest: string | null = null;
        try {
          rest = decodeURIComponent(segments.slice(i).join("/"));
        } catch {
          rest = null;
        }
        if (rest && /^https?:\/\//.test(rest)) push(rest);
      } else if (i > 0) {
        push(u.origin + prefix + segments.slice(i).join("/"));
      }
    }
  }

  // imgix and imgix-backed CDNs (DatoCMS, Prismic). Signed URLs (`s=`) are skipped.
  const hasImgixParams = [...sp.keys()].some((key) => IMGIX_PARAMS.includes(key));
  if (host.endsWith(".imgix.net") || server.includes("imgix") || host === "www.datocms-assets.com" || host === "images.prismic.io" || host.endsWith(".cdn.prismic.io")) {
    if (!sp.has("s") && hasImgixParams) push(withoutParams(u, IMGIX_PARAMS));
  }
  // Unsplash keeps `ixid` (attribution).
  if ((host === "images.unsplash.com" || host === "plus.unsplash.com") && hasImgixParams) push(withoutParams(u, IMGIX_PARAMS));

  // Sanity
  if (host === "cdn.sanity.io" && /^\/images\//.test(path) && u.search) push(withoutQuery(u));

  // Contentful, also on custom domains by Server header
  if ((/^images\.(?:eu\.)?ctfassets\.net$/.test(host) || server.includes("contentful")) && u.search) push(withoutQuery(u));

  // Storyblok
  if (/^a(?:-[a-z]{2})?\.storyblok\.com$/.test(host) || host === "a2.storyblok.com") {
    const m = path.match(/^(\/f\/.+?)\/m(?:\/.*)?$/);
    if (m) push(u.origin + m[1]);
  }
  if (host === "img2.storyblok.com") {
    const m = path.match(/(\/f\/.+)$/);
    if (m) push(`https://a.storyblok.com${m[1]}`);
  }

  // ImageKit
  if (host === "ik.imagekit.io" || server.includes("imagekit")) {
    if (/\/tr:[^/]+\//.test(path)) push(u.origin + path.replace(/\/tr:[^/]+\//, "/") + u.search);
    if (sp.has("tr")) push(withoutParams(u, ["tr"]));
  }

  // Builder.io (the original can be an SVG)
  if (host === "cdn.builder.io" && /^\/api\/v1\/image\//.test(path) && u.search) {
    push(withoutParams(u, ["width", "height", "quality", "format", "fit", "position"]));
  }

  // HubSpot
  if (/^\/hs-fs\/hubfs\//.test(path)) push(u.origin + path.replace(/^\/hs-fs\/hubfs\//, "/hubfs/"));
  else if (/^\/hubfs\//.test(path) && (sp.has("width") || sp.has("height"))) push(withoutParams(u, ["width", "height", "name"]));

  // WordPress uploads: name-300x200.jpg, name-scaled.jpg
  if (/\/wp-content\/uploads\//.test(path)) {
    const size = new RegExp(`-\\d+x\\d+(\\.${IMG_EXT})$`, "i");
    if (size.test(path)) push(u.origin + path.replace(size, "$1"), "medium");
    const scaled = new RegExp(`-scaled(\\.${IMG_EXT})$`, "i");
    if (scaled.test(path)) push(u.origin + path.replace(scaled, "$1"), "medium");
    // Jetpack or VIP on the site's own domain: ?resize=668,445, ?w=668
    if (WORDPRESS_PARAMS.some((key) => sp.has(key))) push(withoutParams(u, [...WORDPRESS_PARAMS, "ssl"]));
  }
  // Jetpack Photon: i0.wp.com/<host>/<path>
  if (/^i[0-3]\.wp\.com$/.test(host)) {
    const m = path.match(/^\/([^/]+\.[^/]+)(\/.*)$/);
    if (m) push(`https://${m[1]}${m[2]}`, "medium");
  }
  // WordPress.com hosted files
  if (/\.wordpress\.com$/.test(host) && ["w", "h", "resize", "fit", "crop"].some((key) => sp.has(key))) {
    push(withoutParams(u, ["w", "h", "resize", "fit", "crop", "zoom"]));
  }

  // Ghost: /content/images/size/w600/(format/webp/)YYYY/MM/file
  {
    const m = path.match(/^(.*\/content\/images)\/size\/[^/]+\/(?:format\/[^/]+\/)?(.+)$/);
    if (m) push(`${u.origin}${m[1]}/${m[2]}`);
  }

  // Hugo image processing: name_hu<hash>_<bytes>_<WxH>_<op>_<opts>.<ext>. The original extension is unknown.
  {
    const m = path.match(/^(.*\/[^/]+?)_hu[0-9a-f]{8,}_\d+_\d*x\d*_(?:resize|fit|fill|crop)[^/]*\.(\w+)$/i);
    if (m) for (const extension of ["png", "jpg", "jpeg", "webp"]) push(`${u.origin}${m[1]}.${extension}`, "low");
  }

  // A query built only from image transform parameters, on a path that already names an image file. Every host rule
  // above is one instance of this shape, so a CDN the list does not know (a Contentful or imgix custom domain, for
  // one) gets the same treatment without needing a `Server` hint. The probe that follows decides whether the stripped
  // URL is real, so a wrong guess costs one request and falls back to the page's own URL.
  if (depth === 0 && !out.length && u.search && new RegExp(`\\.${IMG_EXT}$`, "i").test(path)) {
    const names = [...sp.keys()];
    if (names.length > 0 && names.every((name) => TRANSFORM_ONLY_PARAMS.has(name.toLowerCase()))) push(withoutQuery(u), "medium");
  }

  // Generic proxy: a parameter that carries the source URL, plain or base64. Only when no other rule matched.
  if (!out.length) {
    for (const [key, value] of sp) {
      if (!/^(?:url|src|source|image|img|u|href|imageurl|image_url|file)$/i.test(key)) continue;
      if (/^https?:\/\//i.test(value)) {
        push(value, "medium");
        break;
      }
      const decoded = /^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(value) ? decodeBase64Url(value) : null;
      if (decoded && /^https?:\/\/\S+$/.test(decoded)) {
        push(decoded, "medium");
        break;
      }
    }
  }

  return out;
}

/** Rewrites of `url` toward its original, applied recursively up to depth 3, deepest first then by confidence. */
export function originalCandidates(url: string, hints: CdnHints = {}): string[] {
  const start = tryUrl(url, hints.pageUrl);
  if (!start || !/^https?:$/.test(start.protocol)) return [];
  const found: (Rewrite & { depth: number; index: number })[] = [];
  const seen = new Set([start.href]);
  let frontier = [start];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next: URL[] = [];
    for (const u of frontier) {
      for (const rewrite of oneStep(u, depth === 0 ? hints : {}, depth)) {
        if (seen.has(rewrite.href)) continue;
        seen.add(rewrite.href);
        found.push({ ...rewrite, depth, index: found.length });
        next.push(new URL(rewrite.href));
      }
    }
    frontier = next;
  }
  return found
    .sort((a, b) => b.depth - a.depth || RANK[a.confidence] - RANK[b.confidence] || a.index - b.index)
    .map((rewrite) => rewrite.href);
}

/**
 * The width descriptor a `srcset` build pipeline bakes into the file name (`hero-1500w.webp`). Every entry of one
 * `srcset` is the same picture at a different width, so they belong to one asset. Two digits minimum, so a real name
 * ending in a single digit plus `w` is left alone, and `apple-touch-icon-180.png`, which has no `w`, never matches.
 */
const SRCSET_WIDTH_SUFFIX = new RegExp(`-\\d{2,5}w(\\.${IMG_EXT})$`, "i");

/** Apple Media Services images: the last path segment of a `/image/thumb/` URL is the requested size, not the file. */
const MZSTATIC_HOST = /(^|\.)mzstatic\.com$/i;
const MZSTATIC_SIZE_SEGMENT = new RegExp(`^(/image/thumb/.+)/\\d{2,5}x\\d{2,5}[a-z0-9-]*\\.${IMG_EXT}$`, "i");

/** Grouping key for size variants of one image (spec 8.3). Not a download URL. */
export function variantKey(url: string, hints: CdnHints = {}): string {
  const href = originalCandidates(url, hints)[0] ?? url;
  const u = tryUrl(href, hints.pageUrl);
  if (!u) return href;
  for (const name of PRESENTATIONAL_PARAMS) u.searchParams.delete(name);
  u.pathname = u.pathname
    .replace(new RegExp(`_(?:xsmall|small|medium|large|xlarge|xxlarge)(?:_2x|_3x)?(\\.${IMG_EXT})$`, "i"), "$1")
    .replace(new RegExp(`(?:@[23]x|_2x|_3x)(\\.${IMG_EXT})$`, "i"), "$1")
    .replace(SRCSET_WIDTH_SUFFIX, "$1");
  if (MZSTATIC_HOST.test(u.hostname)) u.pathname = u.pathname.replace(MZSTATIC_SIZE_SEGMENT, "$1");
  return u.href.replace(/\?$/, "");
}
