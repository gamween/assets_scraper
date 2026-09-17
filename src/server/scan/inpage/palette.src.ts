/**
 * In-page brand palette signal collector (browser code, bundled into PALETTE_SOURCE).
 *
 * Installs `globalThis.__assetsScraperPalette`: `collect` hides overlays and returns color samples, `restore` undoes
 * the hiding once the screenshot is taken, `decodeIconColors` rasterizes icon bytes. Port of the validated lab code
 * (v2, every fix enabled). Node runs it in an isolated world with `globalThis` shadowed (`palette/index.ts`), so the
 * functions keep no state between calls: what `restore` needs is stored on the hidden elements.
 */
import type {
  MediaKind, MediaRect, PaletteInPage, PaletteSignalOptions, PaletteSource, RawPaletteSignals, RectTuple,
} from "../palette/signals";

/**
 * Set on every hidden element: "-" when it had no `style` attribute, else "=" followed by that attribute, which
 * `restore` puts back as it was.
 */
const HIDDEN_ATTRIBUTE = "data-palette-hidden";

// Output caps, so a page cannot make the result large (Node applies the same caps in `readSignals`)
const MAX_SAMPLES = 20_000;
const MAX_MEDIA_RECTS = 2_000;
const MAX_LOGO_RECTS = 20;
const MAX_URL_LENGTH = 2_048;
const MAX_VAR_NAME_LENGTH = 100;
/** Colors read from one gradient or paint server (real ones have a handful of stops). */
const MAX_PAINT_COLORS = 64;

function collect(opts: PaletteSignalOptions = {}): RawPaletteSignals {
  const t0 = performance.now();
  const maxElements = opts.maxElements ?? 8000;
  const walkBudgetMs = opts.walkBudgetMs ?? 600;
  const overlayBudgetMs = opts.overlayBudgetMs ?? 300;
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = innerHeight;
  const sy = scrollY;
  const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);

  // ---------- color parsing (any CSS color to 8-bit sRGB plus alpha) ----------
  type RGBA = [number, number, number, number];
  type RGB = [number, number, number];
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  const cache = new Map<string, RGBA | null>();
  const RGB_RE = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/;
  const parse = (str: string | null | undefined): RGBA | null => {
    if (!str) return null;
    str = str.trim();
    if (!str || str === "none" || str === "transparent" || str === "currentcolor") return null;
    const hit = cache.get(str);
    if (hit !== undefined) return hit;
    let v: RGBA | null = null;
    const m = RGB_RE.exec(str);
    // Raw strings (custom properties, meta colors) can hold channels a browser would clamp or refuse.
    const channels = m ? [+m[1], +m[2], +m[3]] : [];
    if (m && channels.every((c) => Number.isFinite(c))) {
      const a = m[4] === undefined ? 1 : m[5] ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      const [r, g, b] = channels.map((c) => Math.min(255, c));
      v = [r, g, b, a];
    } else if (CSS.supports("color", str)) {
      ctx.globalCompositeOperation = "copy";
      ctx.fillStyle = "#000";
      ctx.fillStyle = str;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      v = [d[0], d[1], d[2], d[3] / 255];
    }
    if (v && v[3] < 0.02) v = null;
    cache.set(str, v);
    return v;
  };
  const over = (fg: RGBA, alphaMul: number, bg: RGB): RGB => {
    const a = Math.max(0, Math.min(1, fg[3] * alphaMul));
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
  };
  const hex = (c: RGB | RGBA): string =>
    "#" + ((1 << 24) | (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])).toString(16).slice(1);
  const COLOR_TOKEN_RE = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|#[0-9a-fA-F]{3,8}\b/g;
  const tokens = (s: string): RGBA[] => {
    const out: RGBA[] = [];
    for (const t of (s.match(COLOR_TOKEN_RE) || []).slice(0, MAX_PAINT_COLORS)) {
      const c = parse(t);
      if (c) out.push(c);
    }
    return out;
  };

  // ---------- aggregation ----------
  const agg = new Map<string, [PaletteSource, string, number, number]>();
  const add = (src: PaletteSource, color: string, w: number) => {
    if (!(w > 0)) return;
    const k = src + color;
    const e = agg.get(k);
    if (e) {
      e[2] += w;
      e[3]++;
    } else if (agg.size < MAX_SAMPLES) agg.set(k, [src, color, w, 1]);
  };

  // above-the-fold weighting: [until N viewports, weight]
  const ZONES: [number, number][] = [[1, 1], [2, 0.5], [4, 0.25], [8, 0.1]];
  const maxY = ZONES[ZONES.length - 1][0] * vh;
  const foldW = (y: number) => {
    for (const z of ZONES) if (y < z[0] * vh) return z[1];
    return 0;
  };
  const foldArea = (top: number, bottom: number, width: number) => {
    let s = 0, prev = 0;
    for (const z of ZONES) {
      const a = Math.max(top, prev * vh), b = Math.min(bottom, z[0] * vh);
      if (b > a) s += (b - a) * z[1];
      prev = z[0];
    }
    return s * width;
  };
  const clipRect = (r: DOMRect): RectTuple | null => {
    const x0 = Math.max(0, r.left), x1 = Math.min(vw, r.right);
    const y0 = Math.max(0, r.top), y1 = Math.min(vh, r.bottom);
    return x1 - x0 >= 2 && y1 - y0 >= 2 ? [x0, y0, x1 - x0, y1 - y0] : null;
  };

  // ---------- 1. hide consent banners, modals, backdrops ----------
  const hiddenEls: Element[] = [];
  if (opts.hideOverlays !== false && document.body) {
    const tOverlays = performance.now();
    const overlaysOverBudget = () => performance.now() - tOverlays > overlayBudgetMs;
    const hide = (el: Element) => {
      const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
      if (!style || el === document.body || el === document.documentElement || el.hasAttribute(HIDDEN_ATTRIBUTE)) return;
      const inline = el.getAttribute("style");
      el.setAttribute(HIDDEN_ATTRIBUTE, inline === null ? "-" : "=" + inline);
      // Inline !important wins over every author rule, including a consent manager's own display:block!important
      style.setProperty("display", "none", "important");
      hiddenEls.push(el);
    };
    const CONSENT_SEL = [
      "#onetrust-consent-sdk", "#onetrust-banner-sdk", "#CybotCookiebotDialog", "#usercentrics-root",
      "#usercentrics-cmp-ui", "#truste-consent-track", ".truste_box_overlay", "#didomi-host", "#qc-cmp2-container",
      '[id^="sp_message_container"]', ".osano-cm-window", "#hs-eu-cookie-confirmation", ".cc-window",
      ".cky-consent-container", "#cmpbox", "#axeptio_overlay", "#tarteaucitronRoot", "#iubenda-cs-banner",
      "#cookiescript_injected", '[aria-label*="cookie" i]', '[id*="cookie-banner" i]', '[class*="cookie-banner" i]',
      '[id*="cookieconsent" i]', '[class*="cookieconsent" i]', '[data-testid*="cookie" i]', "#transcend-consent-manager",
      '[class*="consent-banner" i]', '[id*="consent-banner" i]', '[class*="cookie-consent" i]', '[id*="cookie-consent" i]',
      "dialog[open]", '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
    ].join(",");
    // A 0x0 host can still paint through fixed children or a shadow root (Transcend on notion.com: a 0x0 fixed <div> under <html>)
    try {
      for (const el of document.querySelectorAll(CONSENT_SEL)) {
        if (overlaysOverBudget()) break;
        const r = el.getBoundingClientRect();
        if (r.width * r.height > 0 || el.shadowRoot || getComputedStyle(el).position === "fixed") hide(el);
      }
    } catch {
      // bad selector in old engines
    }
    const CONSENT_TEXT = /cookie|consent|gdpr|we value your privacy|we care about your privacy/i;
    const fullCover: Element[] = [];
    let backdropFound = false;
    // Consent managers and modal portals are appended last, next to <body> under <html> or at the end of <body>: those
    // subtrees come first (children of <body> from the last one), so a page too large for the budget still gets them
    // checked before its app root. Each subtree keeps document order, ancestors before descendants.
    const roots = [
      ...[...document.documentElement.children].filter((el) => el !== document.head && el !== document.body),
      ...[...document.body.children].reverse(),
    ];
    let scanned = 0;
    scan: for (const root of roots) {
      for (const el of [root, ...root.querySelectorAll("*")]) {
        if ((++scanned & 63) === 0 && overlaysOverBudget()) break scan;
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        if (cs.display === "none") continue;
        // consent managers rendered in a shadow root under a 0x0 fixed host
        if (el.shadowRoot && CONSENT_TEXT.test((el.shadowRoot.textContent || "").slice(0, 4000))) {
          hide(el);
          continue;
        }
        const r = el.getBoundingClientRect();
        const cr = clipRect(r);
        if (!cr) continue;
        const cover = (cr[2] * cr[3]) / (vw * vh);
        const txt = (el.textContent || "").slice(0, 4000);
        if (cover < 0.75 && CONSENT_TEXT.test(txt) && !el.querySelector("nav") && el.localName !== "header") {
          hide(el);
          continue;
        }
        if (el.localName === "iframe" && cover < 0.6) {
          // fixed iframes: consent banners, chat widgets
          hide(el);
          continue;
        }
        if (cover >= 0.85 && cs.position === "fixed") {
          const bg = parse(cs.backgroundColor);
          if (bg && bg[3] > 0.05 && bg[3] < 0.95 && txt.trim().length < 40) {
            // dimming backdrop
            hide(el);
            backdropFound = true;
          } else if (!bg && txt.length < 1500 && !el.querySelector("nav, header, main")) fullCover.push(el);
        }
      }
    }
    // A dimming backdrop means a modal is open: hide transparent full-screen fixed wrappers (the modal container)
    if (backdropFound) for (const el of fullCover) hide(el);
    // In-flow banners: start from an accept or reject button, climb to the outermost small block that talks about cookies
    const BTN = /^(accept|allow|agree|i agree|ok|okay|got it|reject|decline|deny|refuse|manage|customi[sz]e|cookie settings|preferences|tout accepter|tout refuser|accepter|refuser|continuer sans accepter)\b/i;
    let nb = 0;
    for (const btn of document.querySelectorAll('button, [role="button"], a[role="button"], input[type="button"], input[type="submit"]')) {
      if (++nb > 400 || overlaysOverBudget()) break;
      const label = ((btn as HTMLInputElement).value || btn.textContent || "").trim().slice(0, 40);
      if (!BTN.test(label) || btn.closest(`[${HIDDEN_ATTRIBUTE}]`)) continue;
      let banner: Element | null = null;
      for (let el = btn.parentElement, d = 0; el && el !== document.body && d < 10; el = el.parentElement, d++) {
        const t = el.textContent || "";
        if (t.length > 2500 || el.getBoundingClientRect().height > 0.6 * vh || el.querySelector("nav, header, main, h1")) break;
        // not a lone "Cookie settings" link
        if (CONSENT_TEXT.test(t) && t.replace(/\s+/g, " ").trim().length >= 60) banner = el;
      }
      if (banner) hide(banner);
    }
  }

  // ---------- 2. logo detection ----------
  const hostParts = location.hostname.replace(/^www\./, "").split(".");
  const brandWord = (hostParts.length >= 2 ? hostParts[hostParts.length - 2] : hostParts[0]).toLowerCase();
  let logoEl: Element | null = null;
  {
    let best = 0, bestTop = 1e9;
    const cands = document.querySelectorAll('a, [class*="logo" i], [id*="logo" i], [aria-label*="logo" i], header svg, header img, nav svg, nav img');
    let n = 0;
    for (const c of cands) {
      if (++n > 1500) break;
      if (c.closest(`[${HIDDEN_ATTRIBUTE}]`)) continue;
      const r = c.getBoundingClientRect();
      if (r.top + sy > 240 || r.bottom <= 0 || r.height < 10 || r.height > 150 || r.width < 10 || r.width > 440) continue;
      const hasGraphic = c.localName === "svg" || c.localName === "img" || !!c.querySelector("svg, img");
      let score = hasGraphic ? 0 : -2;
      const a = c.closest("a");
      if (a) {
        try {
          const u = new URL(a.href, location.href);
          const sameSite = u.hostname.replace(/^www\./, "").endsWith(hostParts.slice(-2).join("."));
          if (sameSite && /^\/([a-z]{2}([-_][a-z]{2})?\/?)?$/i.test(u.pathname) && !u.hash) score += 3;
        } catch {
          // ignore
        }
      }
      const attrs = [c.id, c.getAttribute("class"), c.getAttribute("aria-label"), c.getAttribute("alt"), c.getAttribute("title"),
        a && a.getAttribute("aria-label"), a && a.getAttribute("class"), a && a.getAttribute("title")].join(" ").toLowerCase();
      if (attrs.includes("logo")) score += 3;
      if (brandWord.length > 2 && attrs.includes(brandWord)) score += 2;
      if (c.closest('header, nav, [role="banner"]')) score += 1;
      if (r.left < vw * 0.3) score += 1;
      if (hasGraphic && r.left < vw * 0.2 && r.top + sy < 120 && r.width >= 40) score += 2; // wide top-left graphic
      if (score > best || (score === best && r.top < bestTop)) {
        best = score;
        bestTop = r.top;
        logoEl = a && a.contains(c) && a.getBoundingClientRect().height < 160 ? a : c;
      }
    }
    if (best < 4) logoEl = null;
  }

  // ---------- 3. DOM walk ----------
  const SKIP = new Set(["script", "style", "noscript", "template", "link", "meta", "head", "title", "br", "wbr", "defs",
    "clippath", "mask", "symbol", "lineargradient", "radialgradient", "pattern", "filter", "marker", "desc", "metadata", "option"]);
  const MEDIA = new Set(["img", "video", "canvas", "iframe", "embed", "object"]);
  const SHAPES = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline", "line", "text", "use", "tspan"]);
  const isInteractive = (el: Element) => {
    const t = el.localName;
    if (t === "a" || t === "button") return true;
    const role = el.getAttribute("role");
    if (role === "button" || role === "link" || role === "tab") return true;
    return t === "input" && /^(submit|button)$/i.test((el as HTMLInputElement).type);
  };
  const rootCs = getComputedStyle(document.documentElement);
  const bodyCs = document.body ? getComputedStyle(document.body) : rootCs;
  const htmlBg = parse(rootCs.backgroundColor);
  const bodyBg = parse(bodyCs.backgroundColor);
  const WHITE: RGB = [255, 255, 255];
  const canvasColor: RGB = htmlBg ? over(htmlBg, 1, WHITE) : bodyBg ? over(bodyBg, 1, WHITE) : WHITE;
  // background "records": exclusive fold-weighted area, children subtract from their nearest background ancestor
  const recColor: string[] = [hex(canvasColor)];
  const recGrad = new Map<number, string[]>(); // gradient stops owned by a background record
  const recArea: number[] = [foldArea(0, Math.min(Math.max(docH, vh), maxY), vw)];
  let bodyRec = 0;
  let bodyEff = canvasColor;
  if (htmlBg && bodyBg && document.body) {
    const r = document.body.getBoundingClientRect();
    bodyEff = over(bodyBg, 1, canvasColor);
    const a = foldArea(r.top + sy, Math.min(r.bottom + sy, maxY), Math.min(vw, r.width));
    recColor.push(hex(bodyEff));
    recArea.push(a);
    recArea[0] -= a;
    bodyRec = 1;
  }

  interface Frame { el: Element; bg: RGB; op: number; rec: number; logo: boolean; link: boolean; inter: number; ctaDone: boolean }
  const stack: Frame[] = [];
  const pushChildren = (parent: Element, f: Omit<Frame, "el">) => {
    const kids = parent.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ el: kids[i], ...f });
    const sr = (parent as HTMLElement).shadowRoot;
    if (sr) for (let i = sr.children.length - 1; i >= 0; i--) stack.push({ el: sr.children[i], ...f });
  };
  if (document.body) pushChildren(document.body, { bg: bodyEff, op: 1, rec: bodyRec, logo: false, link: false, inter: 0, ctaDone: false });

  const mediaRects: MediaRect[] = [];
  const logoImageRects: RectTuple[] = [];
  let logoBackdrop: string | null = null;
  const gradCache = new Map<string, RGBA[]>();
  const svgPaint = (paint: string): RGBA[] => {
    if (!paint || paint === "none") return [];
    if (paint.startsWith("url(")) {
      const m = /url\(["']?#([^"')]+)/.exec(paint);
      if (!m) return [];
      let g = gradCache.get(m[1]);
      if (!g) {
        const stops: RGBA[] = [];
        const node = document.getElementById(m[1]);
        if (node) {
          for (const s of [...node.querySelectorAll("stop")].slice(0, MAX_PAINT_COLORS)) {
            const c = parse(getComputedStyle(s).stopColor);
            if (c) stops.push(c);
          }
        }
        g = stops;
        gradCache.set(m[1], g);
      }
      return g;
    }
    const c = parse(paint);
    return c ? [c] : [];
  };
  const CTA_MAX_AREA = 0.08 * vw * vh;
  let visited = 0;
  let truncated = false;
  // Own budget: overlay hiding and logo detection do not eat into the walk
  const tWalk = performance.now();

  while (stack.length) {
    const f = stack.pop()!;
    const el = f.el;
    const tag = el.localName;
    if (SKIP.has(tag) || el.hasAttribute(HIDDEN_ATTRIBUTE)) continue;
    if (++visited > maxElements || ((visited & 255) === 0 && performance.now() - tWalk > walkBudgetMs)) {
      truncated = true;
      break;
    }
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const op = f.op * (parseFloat(cs.opacity) || 0);
    if (op < 0.1) continue;
    const r = el.getBoundingClientRect();
    const top = r.top + sy, bottom = r.bottom + sy;
    const pos = cs.position;
    if (top > maxY && pos !== "absolute" && pos !== "fixed") continue;
    const x0 = Math.max(0, r.left), x1 = Math.min(vw, r.right);
    const w = x1 - x0, h = r.height;
    const onScreen = w > 0 && h > 0 && top < maxY && bottom > 0;
    const visible = onScreen && cs.visibility === "visible";
    const inLogo = f.logo || el === logoEl;
    const inter = isInteractive(el);
    const child: Omit<Frame, "el"> = {
      bg: f.bg, op, rec: f.rec, logo: inLogo, link: f.link || tag === "a",
      inter: inter ? 1 : f.inter > 0 && f.inter < 4 ? f.inter + 1 : 0, ctaDone: f.ctaDone,
    };
    if (inLogo && el === logoEl && visible) logoBackdrop = hex(f.bg);

    if (visible) {
      const area = foldArea(Math.max(top, 0), Math.min(bottom, maxY), w);
      const pxArea = w * h;
      const bgc = parse(cs.backgroundColor);
      const bgi = cs.backgroundImage;
      const clipText = cs.backgroundClip === "text" || (cs as unknown as Record<string, string>).webkitBackgroundClip === "text";
      const gradColors = bgi !== "none" && bgi.includes("gradient(") ? tokens(bgi) : [];
      const hasUrl = bgi !== "none" && bgi.includes("url(");

      if (MEDIA.has(tag) || (hasUrl && !clipText)) {
        const cr = clipRect(r);
        if (cr) {
          if (inLogo) {
            if (logoImageRects.length < MAX_LOGO_RECTS) logoImageRects.push(cr);
          } else if (cr[2] * cr[3] > 400 && mediaRects.length < MAX_MEDIA_RECTS) {
            const kind: MediaKind = MEDIA.has(tag) ? (tag === "embed" || tag === "object" ? "iframe" : (tag as MediaKind)) : "bgimg";
            mediaRects.push([cr[0], cr[1], cr[2], cr[3], kind]);
          }
        }
        if (!bgc) recArea[f.rec] -= area; // the image occludes the ancestor background
      }

      // background color
      if (bgc && !clipText) {
        const eff = over(bgc, op, f.bg);
        const hx = hex(eff);
        const alpha = bgc[3] * op;
        child.bg = eff;
        // Translucent layers (under 50 percent) are scrims over photos or hover tints: compositing them over the DOM
        // ancestor produces colors that are never on screen, so they only tint descendants' text
        if (alpha >= 0.5 && tag !== "svg" && !SHAPES.has(tag)) {
          recColor.push(hx);
          recArea.push(area * alpha);
          recArea[f.rec] -= area * alpha;
          child.rec = recArea.length - 1;
        }
        // CTA: interactive element (or its inner wrapper) with a solid fill, button sized
        if (alpha >= 0.5 && !f.ctaDone && (inter || f.inter > 0) && pxArea <= CTA_MAX_AREA && pxArea >= 300 && w >= 16 && h >= 14) {
          add(inLogo ? "logo" : "cta", hx, Math.sqrt(pxArea) * foldW(Math.max(0, top)));
          child.ctaDone = true;
        }
      }
      if (gradColors.length && !clipText) {
        const hexes = gradColors.map((c) => hex(over(c, op, f.bg)));
        if (!f.ctaDone && (inter || f.inter > 0) && pxArea <= CTA_MAX_AREA && pxArea >= 300) {
          for (const hx of hexes) add("cta", hx, (Math.sqrt(pxArea) * foldW(Math.max(0, top))) / hexes.length);
        }
        // A gradient weighs its exclusive area (minus children that paint or show images), like a background color:
        // the full box counted a card's gradient frame as if the whole card were painted (Twitch)
        if (child.rec === f.rec) {
          recColor.push("");
          recArea.push(area);
          recArea[f.rec] -= area;
          child.rec = recArea.length - 1;
        }
        recGrad.set(child.rec, hexes);
      }
      // ghost buttons: interactive, no fill, visible border
      if (inter && !bgc && !gradColors.length && !f.ctaDone && pxArea <= CTA_MAX_AREA && pxArea >= 300 && parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== "none") {
        const bc = parse(cs.borderTopColor);
        if (bc) add("cta", hex(over(bc, op, f.bg)), 0.5 * Math.sqrt(pxArea) * foldW(Math.max(0, top)));
      }
      // borders
      if (cs.borderTopWidth !== "0px" || cs.borderBottomWidth !== "0px" || cs.borderLeftWidth !== "0px" || cs.borderRightWidth !== "0px") {
        const fw = foldW(Math.max(0, top));
        const sides: [string, string, string, number][] = [
          [cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor, w], [cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor, w],
          [cs.borderLeftWidth, cs.borderLeftStyle, cs.borderLeftColor, h], [cs.borderRightWidth, cs.borderRightStyle, cs.borderRightColor, h]];
        for (const s of sides) {
          const bw = parseFloat(s[0]);
          if (!(bw > 0) || s[1] === "none" || s[1] === "hidden") continue;
          const bc = parse(s[2]);
          if (bc) add("border", hex(over(bc, op, f.bg)), Math.min(s[3], vh) * bw * fw);
        }
      }
      // SVG paint
      if (SHAPES.has(tag)) {
        const fw = foldW(Math.max(0, top));
        const fillOp = parseFloat(cs.fillOpacity);
        const fills = svgPaint(cs.fill);
        for (const c of fills) add(inLogo ? "logo" : "svg", hex(over(c, op * (isNaN(fillOp) ? 1 : fillOp), f.bg)), (pxArea * fw) / fills.length);
        const sw = parseFloat(cs.strokeWidth);
        if (sw > 0) {
          const strokes = svgPaint(cs.stroke);
          const so = parseFloat(cs.strokeOpacity);
          for (const c of strokes) {
            add(inLogo ? "logo" : "svg", hex(over(c, op * (isNaN(so) ? 1 : so), f.bg)), (Math.min(2 * (w + h), 4 * vw) * sw * fw) / strokes.length);
          }
        }
      }
      // text (direct text nodes only)
      let chars = 0;
      for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) chars += (n.nodeValue || "").replace(/\s+/g, "").length;
      if (chars > 0 && tag !== "svg" && !SHAPES.has(tag)) {
        const fs = parseFloat(cs.fontSize) || 16;
        const fw = foldW(Math.max(0, top));
        let fillColors: RGBA[] = [];
        const tf = parse(cs.webkitTextFillColor);
        if (tf) fillColors = [tf];
        else if (clipText && gradColors.length) fillColors = gradColors;
        else {
          const c = parse(cs.color);
          if (c) fillColors = [c];
        }
        for (const c of fillColors) {
          const hx = hex(over(c, op, child.bg));
          const wt = (chars * (fs / 16) * fw) / fillColors.length;
          if (inLogo) add("logo", hx, (chars * 0.55 * fs * fs) / fillColors.length);
          else {
            add("text", hx, wt);
            if (child.link && !child.ctaDone) add("link", hx, wt);
          }
        }
      }
    }
    if (tag === "img" || tag === "video" || tag === "canvas" || tag === "iframe") continue;
    pushChildren(el, child);
  }
  for (let i = 0; i < recColor.length; i++) {
    if (!(recArea[i] > 0)) continue;
    if (recColor[i]) add("bg", recColor[i], recArea[i]);
    const g = recGrad.get(i);
    if (g) for (const hx of g) add("grad", hx, recArea[i] / g.length);
  }

  // ---------- 4. CSS custom properties ----------
  const vars: [string, string, number][] = [];
  {
    const EXCLUDE = /(^|[-_])(text|fg|foreground|font|border|line|stroke|outline|shadow|overlay|scrim|backdrop|hover|hovered|active|pressed|focus|focused|visited|disabled|placeholder|muted|subtle|subdued|soft|tint|weak|faint|alpha|transparent|error|danger|warning|warn|success|info|destructive|critical|positive|negative|caution|attention|gray|grey|neutral|slate|zinc|stone|black|white|inverse|inverted|contrast|shade|ring|selection|scrollbar|code|syntax|chart|shiki|prism|hljs|skeleton|shimmer)(?=[-_A-Z0-9]|$)/i;
    const nameScore = (name: string): number => {
      const n = name.slice(2);
      if (EXCLUDE.test(n)) return 0;
      let s = 0;
      if (/^(swiper|plyr|toastify|fa|bs-focus|tw|rdp|sonner|mantine-focus)[-_]/i.test(n)) return 0; // library internals
      if (/brand/i.test(n)) s = 1;
      else if (/(^|[-_])primary(?=[-_A-Z0-9]|$)/i.test(n)) s = 0.8;
      else if (/accent|(^|[-_])(cta|highlight|theme|key|main|signature)(?=[-_A-Z0-9]|$)/i.test(n)) s = 0.6;
      if (!s) return 0;
      const step = /[-_](\d{2,3})[aA]?$/.exec(n);
      if (step && (+step[1] < 400 || +step[1] > 700)) s *= 0.3;
      return s;
    };
    const HSL_CH = /^-?[\d.]+(deg)?\s*,?\s+[\d.]+%\s*,?\s+[\d.]+%$/;
    const RGB_CH = /^\d{1,3}\s*,?\s+\d{1,3}\s*,?\s+\d{1,3}$/;
    const seen = new Set<string>();
    for (const target of [document.documentElement, document.body]) {
      if (!target) continue;
      const cs = getComputedStyle(target);
      for (let i = 0; i < cs.length && vars.length < 400; i++) {
        const name = cs[i];
        if (!name.startsWith("--") || name.length > MAX_VAR_NAME_LENGTH || seen.has(name)) continue;
        seen.add(name);
        const s = nameScore(name);
        if (!s) continue;
        const raw = cs.getPropertyValue(name).trim();
        if (!raw || raw.length > 80) continue;
        const c = parse(raw) || (HSL_CH.test(raw) ? parse(`hsl(${raw})`) : RGB_CH.test(raw) ? parse(`rgb(${raw})`) : null);
        if (c && c[3] >= 0.6) vars.push([name, hex(c), s]);
      }
    }
  }

  // ---------- 5. meta, manifest and icons ----------
  const meta: RawPaletteSignals["meta"] = { themeColor: null, tileColor: null, maskIconColor: null, manifestTheme: null, manifestBackground: null };
  const toHex = (s: string | null | undefined) => {
    const c = parse(s);
    return c && c[3] > 0.5 ? hex(c) : null;
  };
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    const media = m.getAttribute("media");
    if (media && !matchMedia(media).matches) continue;
    meta.themeColor = toHex(m.getAttribute("content"));
    if (meta.themeColor) break;
  }
  meta.tileColor = toHex(document.querySelector('meta[name="msapplication-TileColor"]')?.getAttribute("content"));
  meta.maskIconColor = toHex(document.querySelector('link[rel="mask-icon"]')?.getAttribute("color"));
  // Icon and manifest URLs are fetched from Node (page CSP and CORS often block in-page fetches)
  const iconLinks = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="apple-touch-icon"], link[rel~="icon"]')]
    .filter((l) => l.href && l.href.length <= MAX_URL_LENGTH && !l.href.startsWith("data:"))
    .map((l) => ({
      href: l.href,
      apple: l.rel.includes("apple"),
      score: (l.rel.includes("apple") ? 1000 : 0) + (parseInt(l.sizes?.value || "", 10) || (/\.svg/i.test(l.href) ? 512 : /\.ico(\?|$)/i.test(l.href) ? 8 : 32)),
    }))
    .sort((a, b) => b.score - a.score);
  const iconUrls = iconLinks.map((i) => i.href);
  // conventional path, tried second when no apple-touch-icon is declared
  if (!iconLinks.some((i) => i.apple)) iconUrls.splice(1, 0, location.origin + "/apple-touch-icon.png");
  const manifestHref = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href;
  const manifestUrl = manifestHref && manifestHref.length <= MAX_URL_LENGTH ? manifestHref : null;

  return {
    url: location.href.length <= MAX_URL_LENGTH ? location.href : "", vw, vh, docH,
    samples: [...agg.values()].map((s) => [s[0], s[1], Math.round(s[2] * 100) / 100, s[3]] as [PaletteSource, string, number, number]),
    vars, meta, mediaRects, logoImageRects, logoBackdrop, logoFound: !!logoEl,
    iconUrls: [...new Set(iconUrls)].slice(0, 3), manifestUrl,
    stats: { visited, walkMs: Math.round(performance.now() - t0), hidden: hiddenEls.length, truncated },
  };
}

/** Rasterizes raster icon bytes at 64 px; SVG icons are parsed in Node. */
async function decodeIconColors(arg: { b64: string; mime: string }): Promise<[string, number][]> {
  const { b64, mime } = arg;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
  const S = 64;
  const c2 = document.createElement("canvas");
  c2.width = c2.height = S;
  const x2 = c2.getContext("2d", { willReadFrequently: true })!;
  // createImageBitmap(Blob) loads no URL, so the page CSP (img-src) does not apply
  const bmp = await createImageBitmap(blob, { resizeWidth: S, resizeHeight: S, resizeQuality: "medium" });
  x2.drawImage(bmp, 0, 0, S, S);
  bmp.close();
  const d = x2.getImageData(0, 0, S, S).data;
  const bins = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 160) continue;
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const b = bins.get(k) || [0, 0, 0, 0];
    b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++;
    bins.set(k, b);
  }
  const out: [string, number][] = [];
  for (const b of bins.values()) {
    if (b[3] >= 8) out.push(["#" + ((1 << 24) | (Math.round(b[0] / b[3]) << 16) | (Math.round(b[1] / b[3]) << 8) | Math.round(b[2] / b[3])).toString(16).slice(1), b[3]]);
  }
  return out;
}

function restore(): void {
  for (const el of document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`)) {
    const saved = el.getAttribute(HIDDEN_ATTRIBUTE) || "";
    if (saved !== "-" && !saved.startsWith("=")) continue; // the page's own attribute, never hidden by collect
    el.removeAttribute(HIDDEN_ATTRIBUTE);
    if (saved === "-") el.removeAttribute("style");
    else el.setAttribute("style", saved.slice(1));
  }
}

// Not a global of the app: this lands on the object that shadows `globalThis` in the evaluated expression.
(globalThis as { __assetsScraperPalette?: PaletteInPage }).__assetsScraperPalette = { collect, restore, decodeIconColors };
