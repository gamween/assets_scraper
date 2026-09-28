import type { FontFamily, FontFormat } from "@/lib/contract";
import type { AgentScan, ScanSummary } from "./types";

/**
 * What an agent reads after a scan (spec 2, context cost): counts, the palette, one row per font family and the logos.
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
export const MAX_SUMMARY_LOGOS = 8;
export const MAX_SUMMARY_PALETTE = 12;
export const MAX_SUMMARY_FONTS = 12;
export const MAX_SUMMARY_WARNINGS = 5;
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

/** Formats the installer can turn into a TTF (spec 5.2). EOT and the rest are not worth installing. */
const INSTALLABLE_FORMATS = new Set<FontFormat>(["woff2", "woff", "ttf", "otf"]);

/**
 * Whether `installFonts` could install this family: its bytes are reachable (Adobe Fonts kits never are) and at least
 * one file is in a format that converts. The licence does not decide it: a commercial family installs too, with its
 * licence reported (spec 5.5).
 */
export function isInstallableFamily(family: FontFamily): boolean {
  if (!family.downloadable) return false;
  return family.faces.some((face) =>
    face.files.some((file) => INSTALLABLE_FORMATS.has(file.format) && (file.inline !== undefined || file.url !== "")),
  );
}

const LOGO_ROLES = new Set(["site-logo", "logo"]);

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
      installable: isInstallableFamily(family),
    })),
    logos,
    otherAssets: Math.max(0, scan.assets.length - logos.length),
    warnings: scan.warnings.slice(0, MAX_SUMMARY_WARNINGS).map((warning) => cut(warning, MAX_WARNING_CHARS)),
    durationMs: scan.stats.durationMs,
  }, scan.assets.length);
}

/** Rows a summary gives up, in the order it gives them up, when the caps alone leave the document too wide. */
const TRIMMABLE = ["warnings", "fonts", "logos", "palette"] as const;

/**
 * Drops rows until the document fits `MAX_SUMMARY_BYTES`, least useful first, and keeps `otherAssets` honest about the
 * logos it gave up. The counts, the page and the scan id are never dropped: an agent needs them to ask for anything
 * else. Only a page at every cap at once ever reaches this, and the lists are documented as capped either way.
 */
function fit(summary: ScanSummary, assetCount: number): ScanSummary {
  for (const list of TRIMMABLE) {
    while (summary[list].length > 0 && Buffer.byteLength(JSON.stringify(summary)) > MAX_SUMMARY_BYTES) {
      summary[list].pop();
      summary.otherAssets = Math.max(0, assetCount - summary.logos.length);
    }
  }
  return summary;
}
