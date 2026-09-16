import { createHash } from "node:crypto";
import { chromium, type Browser } from "playwright-core";
import { parseFontBinary } from "@/server/scan/fonts";
import { parseFontSrc } from "@/server/scan/fonts/css";
import type { CapturedFont, CapturedNetwork, CapturedSheet, RawCollectorOutput, RawFontFaceRule, RawFontStatus, RawFontUsage, Signer } from "@/server/scan/types";

export function launchChrome(): Promise<Browser> {
  const executablePath = process.env.CHROME_EXECUTABLE_PATH;
  return chromium.launch(executablePath ? { executablePath } : { channel: "chrome" });
}

/**
 * A minimal stand-in for the font part of the in-page collector (Track C): `@font-face` rules from the CSSOM,
 * `document.fonts` statuses and visible text usage. Plain JavaScript in a string, so no transform helper leaks into
 * the page.
 */
const FONT_COLLECTOR = String.raw`(async () => {
  await document.fonts.ready;
  const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");
  const fontFaces = [];
  const unreadableSheets = [];
  const walkRules = (rules, baseUrl) => {
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) {
        const style = rule.style;
        fontFaces.push({
          family: unquote(style.getPropertyValue("font-family")),
          src: style.getPropertyValue("src"),
          weight: style.getPropertyValue("font-weight"),
          style: style.getPropertyValue("font-style"),
          stretch: style.getPropertyValue("font-stretch"),
          unicodeRange: style.getPropertyValue("unicode-range"),
          baseUrl,
        });
      } else if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) walkSheet(rule.styleSheet);
      } else if (rule.cssRules) {
        walkRules(rule.cssRules, baseUrl);
      }
    }
  };
  const walkSheet = (sheet) => {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      if (sheet.href) unreadableSheets.push(sheet.href);
      return;
    }
    walkRules(rules, sheet.href || document.baseURI);
  };
  for (const sheet of document.styleSheets) walkSheet(sheet);
  const fontStatuses = [...document.fonts].map((face) => ({ family: unquote(face.family), weight: face.weight, style: face.style, stretch: face.stretch, status: face.status }));
  const usage = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    const chars = node.data.replace(/\s+/g, "").length;
    if (!element || !chars || element.closest("script, style, noscript, template") || !element.getClientRects().length) continue;
    const computed = getComputedStyle(element);
    if (computed.visibility !== "visible") continue;
    const key = computed.fontFamily + "|" + computed.fontWeight + "|" + computed.fontStyle;
    const entry = usage.get(key) || { stack: computed.fontFamily, weight: computed.fontWeight, style: computed.fontStyle, chars: 0 };
    entry.chars += chars;
    usage.set(key, entry);
  }
  return { fontFaces, fontStatuses, fontUsage: [...usage.values()], unreadableSheets };
})()`;

interface PageFonts {
  fontFaces: (Omit<RawFontFaceRule, "src" | "origin"> & { src: string })[];
  fontStatuses: RawFontStatus[];
  fontUsage: RawFontUsage[];
  unreadableSheets: string[];
}

/** Loads a page in a fresh context, captures font and stylesheet responses, and runs the font collector. */
export async function scanPageFonts(browser: Browser, url: string): Promise<{ collector: RawCollectorOutput; network: CapturedNetwork }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const fonts: CapturedFont[] = [];
    const sheets: CapturedSheet[] = [];
    const reads: Promise<void>[] = [];
    page.on("response", (response) => {
      const type = response.request().resourceType();
      if (type !== "font" && type !== "stylesheet") return;
      reads.push(
        (async () => {
          const body = await response.body().catch(() => null);
          const base = { url: response.url(), status: response.status() };
          if (type === "stylesheet") {
            sheets.push({ ...base, cssText: body?.toString("utf8") ?? "" });
            return;
          }
          fonts.push({
            ...base,
            contentType: (await response.headerValue("content-type")) ?? "",
            bytes: body?.length,
            sha1: body ? createHash("sha1").update(body).digest("hex") : undefined,
            meta: body ? parseFontBinary(body) : null,
          });
        })(),
      );
    });
    await page.goto(url, { waitUntil: "load" });
    const found = (await page.evaluate(FONT_COLLECTOR)) as PageFonts;
    await page.waitForLoadState("networkidle").catch(() => {});
    await Promise.all(reads);
    const collector: RawCollectorOutput = {
      page: { title: await page.title(), baseUrl: page.url(), elementCount: 0 },
      candidates: [],
      svgs: [],
      fontFaces: found.fontFaces.map((face) => ({
        family: face.family,
        src: parseFontSrc(face.src, face.baseUrl),
        weight: face.weight,
        style: face.style,
        stretch: face.stretch || undefined,
        unicodeRange: face.unicodeRange || undefined,
        baseUrl: face.baseUrl,
        origin: "cssom",
      })),
      fontStatuses: found.fontStatuses,
      fontUsage: found.fontUsage,
      unreadableSheets: found.unreadableSheets,
      blobs: [],
      brandLinks: [],
      noise: {},
      stats: { elements: 0, ms: 0, truncated: false },
    };
    return { collector, network: { images: [], fonts, sheets, bodyTimeouts: 0, skippedBodies: 0 } };
  } finally {
    await context.close();
  }
}

export interface RecordingSigner extends Signer {
  signed: string[];
}

export function fakeSigner(): RecordingSigner {
  const signed: string[] = [];
  return {
    signed,
    sign(url) {
      signed.push(url);
      return `/api/asset?u=${encodeURIComponent(url)}`;
    },
    get count() {
      return signed.length;
    },
  };
}
