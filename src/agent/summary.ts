import { isInstallableFamily } from "./font-candidates";
import type { BrandFileType, Wordmark } from "@/lib/contract";
import type { AgentScan, ScanSummary } from "./types";

/**
 * What an agent reads after a scan (spec 2, context cost): counts, the palette, one row per font family, the logos, the
 * wordmark, and the page's brand kit links and files.
 * Never the whole asset list, never bytes. The whole document stays a few hundred bytes wide whatever the page holds,
 * so every string it carries is cut and every list is capped.
 */

/**
 * Bytes the whole document stays under, so an agent can read it and still have its context (spec 2). The caps below are
 * what normally keeps it there, and `fit` is the guarantee: with every string at its cap, 8 logos carrying a 40
 * character sha1 id, 12 font families and 12 swatches measure well over it, so the caps alone are not a bound.
 */
export const MAX_SUMMARY_BYTES = 4_096;

/** Logo rows a summary shows. Past that, an agent lists assets with the filters it wants. */
const MAX_SUMMARY_LOGOS = 8;
const MAX_SUMMARY_PALETTE = 12;
const MAX_SUMMARY_FONTS = 12;
const MAX_SUMMARY_WARNINGS = 5;
/** The engine keeps 6 (`limits.maxBrandLinks`); the cap is here too so a hosted app that sends more cannot widen this. */
const MAX_SUMMARY_BRAND_LINKS = 6;
/** Brand file rows a summary shows, of the 16 a scan keeps (`limits.maxBrandFiles`). */
const MAX_SUMMARY_BRAND_FILES = 8;
/**
 * The engine keeps a wordmark of 40 characters in at most 4 runs (`inpage/wordmark.ts`); the caps are here too so a
 * hosted app that sends more cannot widen this.
 */
const MAX_WORDMARK_CHARS = 40;
const MAX_WORDMARK_RUNS = 4;
/** Archives first, then documents, then single logo files: a kit's archive holds the rest. */
const BRAND_FILE_ORDER: Record<BrandFileType, number> = { zip: 0, pdf: 1, ai: 1, eps: 1, svg: 2, png: 3 };
/**
 * URLs are cut like every other string here: `ScanRequest` allows 2048 characters and a redirect chain can make the
 * final URL as long again, which on its own blew the budget the rest of the document is cut to keep.
 */
const MAX_URL_CHARS = 200;
/** DNS allows a host of 253 characters, and a summary has no use for more than the front of one that long. */
const MAX_HOST_CHARS = 100;
const MAX_TITLE_CHARS = 120;
const MAX_SITE_NAME_CHARS = 60;
const MAX_NAME_CHARS = 60;
const MAX_WARNING_CHARS = 120;

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const LOGO_ROLES = new Set(["site-logo", "logo"]);

/**
 * A wordmark with every string cut and its runs capped, like every other row here. The runs are the text cut by colour,
 * so they share its cap rather than taking one each.
 */
const summaryWordmark = (wordmark: Wordmark): Wordmark => {
  const runs: Wordmark["runs"] = [];
  let left = MAX_WORDMARK_CHARS;
  for (const run of wordmark.runs.slice(0, MAX_WORDMARK_RUNS)) {
    if (left <= 0) break;
    const text = cut(run.text, left);
    runs.push({ text, hex: run.hex });
    left -= text.length;
  }
  return {
    text: cut(wordmark.text, MAX_WORDMARK_CHARS),
    family: cut(wordmark.family, MAX_NAME_CHARS),
    weight: wordmark.weight,
    size: wordmark.size,
    letterSpacing: wordmark.letterSpacing,
    transform: wordmark.transform,
    runs,
    ...(wordmark.withLogo === undefined ? {} : { withLogo: { ...wordmark.withLogo, id: cut(wordmark.withLogo.id, MAX_NAME_CHARS) } }),
  };
};

export function summarize(scan: AgentScan): ScanSummary {
  const logos = scan.assets
    .filter((asset) => LOGO_ROLES.has(asset.role))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_SUMMARY_LOGOS)
    .map((asset) => ({
      id: asset.id,
      name: cut(asset.name, MAX_NAME_CHARS),
      kind: asset.kind,
      // The format and the file size are what tell a wordmark from a hero photo: v1 gives role `logo` to both, so on
      // stripe.com the third of eight logo rows was a 4.27 MB 2460x1060 PNG and SKILL.md sends the agent to these rows to
      // find the site logo. They are two short fields, and they are the only signal this row had none of (review issue 11).
      format: asset.format,
      ...(asset.width === undefined ? {} : { width: asset.width }),
      ...(asset.height === undefined ? {} : { height: asset.height }),
      ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
    }));

  const swatches = [...(scan.palette?.brand ?? []), ...(scan.palette?.neutrals ?? [])]
    .slice(0, MAX_SUMMARY_PALETTE)
    .map((swatch) => (swatch.role === undefined ? { hex: swatch.hex } : { hex: swatch.hex, role: swatch.role }));

  const hidden = Object.values(scan.stats.hidden).reduce((total, count) => total + count, 0);
  const brandFiles = (scan.page.brandFiles ?? []).slice().sort((a, b) => BRAND_FILE_ORDER[a.type] - BRAND_FILE_ORDER[b.type]);

  return fit({
    scanId: scan.scanId,
    page: {
      url: cut(scan.page.url, MAX_URL_CHARS),
      finalUrl: cut(scan.page.finalUrl, MAX_URL_CHARS),
      host: cut(scan.page.host, MAX_HOST_CHARS),
      title: cut(scan.page.title, MAX_TITLE_CHARS),
      ...(scan.page.siteName === undefined ? {} : { siteName: cut(scan.page.siteName, MAX_SITE_NAME_CHARS) }),
    },
    counts: {
      assets: scan.stats.assets,
      svg: scan.stats.svg,
      images: scan.stats.images,
      fonts: scan.stats.fonts,
      hidden,
    },
    palette: swatches,
    fonts: scan.fonts.slice(0, MAX_SUMMARY_FONTS).map((family) => ({
      family: cut(family.name, MAX_NAME_CHARS),
      license: family.license.kind,
      usedOnPage: family.usedOnPage,
      // The installer's own rule (`font-candidates.ts`), so this column never promises what `install_fonts` refuses.
      installable: isInstallableFamily(family),
    })),
    logos,
    // investirday.fr shows its monogram as a PNG beside "Investir" over "Day" in live text: without the text, the logo
    // rows hold half of the lockup, and on 15/10/2026 it had to be put back together by hand.
    ...(scan.page.wordmark === undefined ? {} : { wordmark: summaryWordmark(scan.page.wordmark) }),
    // The page's own way to its official files: bnbchain.org links its brand guidelines, where the white, yellow and
    // black logos are, while the home page itself only shows the yellow one.
    brandLinks: (scan.page.brandLinks ?? [])
      .slice(0, MAX_SUMMARY_BRAND_LINKS)
      .map((link) => ({ href: cut(link.href, MAX_URL_CHARS), text: cut(link.text, MAX_NAME_CHARS) })),
    // monad.xyz shows its logo as an animation and keeps the 29.7 MB kit, every logo in SVG, behind a button: the files
    // are where the official vectors are, and the asset list never holds them.
    brandFiles: brandFiles.slice(0, MAX_SUMMARY_BRAND_FILES).map((file) => ({
      id: cut(file.id, MAX_NAME_CHARS),
      name: cut(file.name, MAX_NAME_CHARS),
      type: file.type,
      ...(file.bytes === undefined ? {} : { bytes: file.bytes }),
      url: cut(file.url, MAX_URL_CHARS),
    })),
    otherBrandFiles: Math.max(0, brandFiles.length - MAX_SUMMARY_BRAND_FILES),
    otherAssets: Math.max(0, scan.assets.length - logos.length),
    warnings: scan.warnings.slice(0, MAX_SUMMARY_WARNINGS).map((warning) => cut(warning, MAX_WARNING_CHARS)),
    durationMs: scan.stats.durationMs,
  }, scan.assets.length, brandFiles.length);
}

/**
 * What a summary gives up, in the order it gives it up, when the caps alone leave the document too wide: rows of the
 * lists, and the wordmark whole, before the logos it is the other half of.
 */
const TRIMMABLE = ["warnings", "fonts", "brandLinks", "brandFiles", "wordmark", "logos", "palette"] as const;

/**
 * Drops rows until the document fits `MAX_SUMMARY_BYTES`, least useful first, and keeps `otherAssets` and
 * `otherBrandFiles` honest about the rows it gave up. The counts, the page and the scan id are never dropped: an agent needs them to ask for anything
 * else. Only a page at every cap at once ever reaches this, and the lists are documented as capped either way.
 */
export function fit(summary: ScanSummary, assetCount: number, brandFileCount: number): ScanSummary {
  const tooWide = () => Buffer.byteLength(JSON.stringify(summary)) > MAX_SUMMARY_BYTES;
  for (const list of TRIMMABLE) {
    if (list === "wordmark") {
      if (summary.wordmark !== undefined && tooWide()) delete summary.wordmark;
      continue;
    }
    while (summary[list].length > 0 && tooWide()) {
      summary[list].pop();
      summary.otherAssets = Math.max(0, assetCount - summary.logos.length);
      summary.otherBrandFiles = Math.max(0, brandFileCount - summary.brandFiles.length);
    }
  }
  return summary;
}
