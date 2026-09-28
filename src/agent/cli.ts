import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pkg from "../../package.json";
import { AssetKind, AssetRole } from "@/lib/contract";
import { formatBytes, formatCount, formatDimensions, formatDuration } from "@/lib/format";
import { ScanFailure } from "@/server/errors";
import { findRecentScan, saveScan } from "./cache";
import { downloadAssets } from "./download";
import { listInstalledFonts } from "./font-manifest";
import { formatFontInstall, formatFontList, formatFontUninstall } from "./font-report";
import { installFonts, uninstallFonts } from "./fonts";
import { normalizeScanUrl } from "./scan-url";
import { createLocalScanSource } from "./source-local";
import { createRemoteScanSource } from "./source-remote";
import { summarize } from "./summary";
import type { AgentScan, DownloadResult, DropReason, ScanSource, ScanSummary, SelectionOptions, SelectionProfile } from "./types";

/**
 * The `assets-scraper` command (spec 7). Human output by default, `--json` for agents, one line on stderr and exit 1 on
 * failure, and every path printed absolute.
 */

const VERSION: string = pkg.version;

/** The hosted app `--remote` uses when nothing else names one (spec 8). */
export const DEFAULT_REMOTE = "https://assets-scraper.vercel.app";

export const USAGE = `assets-scraper: pull the usable assets of a page.

Usage
  assets-scraper scan <url> [options]
      Scan a page and print what is on it: counts, palette, fonts, logos.
  assets-scraper get <url> [options]
      Scan a page and download a selection into scrap/<host> inside the current project.
  assets-scraper fonts install <url> [options]
      Scan a page, convert its fonts to TTF and install them in the user font directory.
  assets-scraper fonts list [options]
      What this tool installed, with the licence, the files and where they came from.
  assets-scraper fonts uninstall <family> [options]
      Remove the files install wrote for these families.

Options
  --out DIR             Where to write. Default: <project root>/scrap/<host>, or ~/Downloads/assets-scraper/<host>
  --profile deck|all    deck (default) drops icons, thumbnails, small images and duplicates. all keeps everything
  --kind svg,image      Only these kinds
  --role logo,site-logo Only these roles
  --min-long-side 600   Drop a raster whose longest side is under this, logos and favicons excepted
  --max 60              Files one download writes, highest scoring first
  --name-contains TEXT  Only assets whose name holds TEXT
  --include-icons       Keep icons the deck profile would drop
  --families "A,B"      Font families to install or remove, as scan reported them
  --json                Print JSON instead of a report
  --refresh             Scan again instead of reusing a scan of the last hour
  --remote              Scan on the hosted app. Needs ASSETS_SCRAPER_TOKEN
  --remote-url URL      The hosted app to use. Default: ASSETS_SCRAPER_REMOTE, then ${DEFAULT_REMOTE}
  --token TOKEN         Agent token for the hosted app. Default: ASSETS_SCRAPER_TOKEN
  --help, --version

Examples
  assets-scraper scan stripe.com
  assets-scraper get stripe.com --role logo,site-logo --json
  assets-scraper get stripe.com --profile all --kind svg --out ./brand
  assets-scraper fonts install stripe.com --families "Söhne"
`;

/** How the report names each drop reason, so one line can say why a file was not taken. */
const DROP_LABELS: Record<DropReason, string> = {
  icon: "icons",
  sprite: "sprite symbols",
  small: "too small",
  duplicate: "duplicates",
  "near-duplicate": "the same picture twice",
  "vector-preferred": "raster copies of an svg",
  "extra-favicon": "extra favicons",
  filter: "filtered out",
  cap: "over the file limit",
  unavailable: "unavailable",
};

const OPTIONS = {
  out: { type: "string" },
  profile: { type: "string" },
  kind: { type: "string" },
  role: { type: "string" },
  "min-long-side": { type: "string" },
  max: { type: "string" },
  "name-contains": { type: "string" },
  "include-icons": { type: "boolean" },
  families: { type: "string" },
  json: { type: "boolean" },
  refresh: { type: "boolean" },
  remote: { type: "boolean" },
  "remote-url": { type: "string" },
  token: { type: "string" },
  help: { type: "boolean" },
  version: { type: "boolean" },
} as const;

type Values = Partial<Record<keyof typeof OPTIONS, string | boolean>>;

/** A message the CLI prints as its one line on stderr before exiting 1. Never a stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const asString = (values: Values, name: keyof typeof OPTIONS): string | undefined => {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
};

/** A whole number above 0, or a usage error naming the option. */
function wholeNumber(values: Values, name: keyof typeof OPTIONS): number | undefined {
  const raw = asString(values, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new UsageError(`--${name} takes a whole number above 0, not ${JSON.stringify(raw)}`);
  return value;
}

/** A comma separated list checked against one of the contract enums, so a typo is an error and not an empty result. */
function enumList<T extends string>(values: Values, name: keyof typeof OPTIONS, allowed: readonly T[]): T[] | undefined {
  const raw = asString(values, name);
  if (raw === undefined) return undefined;
  const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new UsageError(`--${name} takes a comma separated list of ${allowed.join(", ")}`);
  for (const item of items) {
    if (!allowed.includes(item as T)) throw new UsageError(`--${name} does not know ${JSON.stringify(item)}. It takes ${allowed.join(", ")}`);
  }
  return items as T[];
}

export function selectionFrom(values: Values): SelectionOptions {
  const profile = asString(values, "profile");
  if (profile !== undefined && profile !== "deck" && profile !== "all") {
    throw new UsageError(`--profile takes deck or all, not ${JSON.stringify(profile)}`);
  }
  const kinds = enumList(values, "kind", AssetKind.options);
  const roles = enumList(values, "role", AssetRole.options);
  const minLongSide = wholeNumber(values, "min-long-side");
  const max = wholeNumber(values, "max");
  const nameContains = asString(values, "name-contains");
  return {
    ...(profile === undefined ? {} : { profile: profile as SelectionProfile }),
    ...(kinds === undefined ? {} : { kinds }),
    ...(roles === undefined ? {} : { roles }),
    ...(minLongSide === undefined ? {} : { minLongSide }),
    ...(max === undefined ? {} : { max }),
    ...(nameContains === undefined ? {} : { nameContains }),
    ...(values["include-icons"] === true ? { includeIcons: true } : {}),
  };
}

/**
 * The URL to scan (`normalizeScanUrl`), as a usage error when it is not one. The error carries the v1 code, so an agent
 * reading stderr gets the vocabulary the API uses.
 */
export function scanUrl(raw: string): string {
  const url = normalizeScanUrl(raw);
  if (url === null) throw new UsageError(`invalid-url: ${JSON.stringify(raw)} is not a web address`);
  return url;
}

/** Where the scan runs (spec 2): the hosted app when `--remote`, `--remote-url` or `ASSETS_SCRAPER_REMOTE` names one. */
export function openSource(values: Values): ScanSource {
  const named = asString(values, "remote-url")?.trim() || process.env.ASSETS_SCRAPER_REMOTE?.trim() || "";
  const remote = named || (values.remote === true ? DEFAULT_REMOTE : "");
  if (remote === "") return createLocalScanSource();
  const token = asString(values, "token");
  return createRemoteScanSource({ remote, ...(token === undefined ? {} : { token }) });
}

/**
 * The scan of `url` from the cache when one is fresh (spec 6), otherwise a new one, saved for the next command. Only a
 * scan this source produced counts: `--remote` answering from a local scan would be a claim about the hosted app that
 * the answer does not back, and so would a run against one `--remote-url` answering from a scan of another.
 */
export async function scanPage(url: string, source: ScanSource, values: Values): Promise<{ scan: AgentScan; reused: boolean }> {
  if (values.refresh !== true) {
    const cached = await findRecentScan(url, source);
    if (cached) return { scan: cached, reused: true };
  }
  // Progress goes to a terminal only: piped output is read by an agent, which wants the answer and nothing else.
  const interactive = values.json !== true && process.stderr.isTTY === true;
  const scan = await source.scan(url, interactive ? { onStep: (step) => process.stderr.write(`  ${step}\n`) } : undefined);
  await saveScan(scan);
  return { scan, reused: false };
}

const line = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

/** "8 icons, 4 too small", the one line a report gives to why files were not taken. */
export function formatDropped(dropped: Partial<Record<DropReason, number>>): string {
  const reasons = (Object.entries(dropped) as [DropReason, number][])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${DROP_LABELS[reason] ?? reason}`);
  return reasons.join(", ");
}

const total = (dropped: Partial<Record<DropReason, number>>): number =>
  Object.values(dropped).reduce((sum, count) => sum + (count ?? 0), 0);

export function formatSummary(summary: ScanSummary, reused: boolean): string {
  const rows: string[] = [];
  rows.push(`${summary.page.title || summary.page.host} (${summary.page.host})`);
  rows.push(`  url: ${summary.page.finalUrl}`);
  const counts = summary.counts;
  rows.push(
    `  ${formatCount(counts.assets, "asset")}: ${counts.svg} svg, ${counts.images} images, ` +
      `${formatCount(counts.fonts, "font family", "font families")}, ${counts.hidden} hidden, in ${formatDuration(summary.durationMs)}`,
  );
  if (summary.palette.length > 0) {
    rows.push(`  palette: ${summary.palette.map((swatch) => (swatch.role ? `${swatch.hex} ${swatch.role}` : swatch.hex)).join(", ")}`);
  }
  for (const font of summary.fonts) {
    const notes = [`${font.license} licence`, font.usedOnPage ? "used on the page" : "declared only", font.installable ? "installable" : "not installable"];
    rows.push(`  font: ${font.family} (${notes.join(", ")})`);
  }
  if (summary.logos.length > 0) {
    rows.push("  logos:");
    for (const logo of summary.logos) {
      // The format and the size, not just the kind: v1 gives role `logo` to a hero photo as well as to a wordmark.
      const size = [formatDimensions(logo.width, logo.height) || "size unknown", logo.bytes === undefined ? "" : formatBytes(logo.bytes)];
      rows.push(`    ${logo.id}  ${logo.name}  ${logo.format}  ${size.filter(Boolean).join(", ")}`);
    }
  }
  if (summary.otherAssets > 0) rows.push(`  and ${formatCount(summary.otherAssets, "other asset")}`);
  for (const warning of summary.warnings) rows.push(`  warning: ${warning}`);
  rows.push(`  scan id: ${summary.scanId}${reused ? " (reused from the cache, --refresh to scan again)" : ""}`);
  return rows.join("\n");
}

export function formatDownload(result: DownloadResult): string {
  const rows: string[] = [];
  rows.push(`wrote ${formatCount(result.files.length, "file")}, ${formatBytes(result.totalBytes)} into ${result.dir}`);
  for (const file of result.files) rows.push(`  ${file.path}`);
  const missed = total(result.dropped);
  if (missed > 0) rows.push(`dropped ${missed}: ${formatDropped(result.dropped)}`);
  for (const failure of result.failed) rows.push(`failed: ${failure.name} (${failure.reason})`);
  rows.push(`manifest: ${result.manifestPath}`);
  return rows.join("\n");
}

/** The families `--families`, or the positionals of `fonts uninstall`, name. */
function familyList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const families = raw.split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (families.length === 0) throw new UsageError("--families takes a comma separated list of family names");
  return families;
}

/** `fonts install`, `fonts list` and `fonts uninstall` (spec 7): the font side of the same scan the other commands use. */
async function runFonts(positionals: string[], values: Values): Promise<number> {
  const subcommand = positionals[1];
  const named = familyList(asString(values, "families"));
  switch (subcommand) {
    case "install": {
      const url = positionals[2];
      if (!url) throw new UsageError("fonts install needs a URL: assets-scraper fonts install stripe.com");
      const source = openSource(values);
      const { scan } = await scanPage(scanUrl(url), source, values);
      const report = await installFonts(scan.fonts, {
        fetchBytes: (file, fetchOptions) => source.fetchBytes(file, fetchOptions),
        pageHost: scan.page.host,
        ...(named === undefined ? {} : { only: named }),
      });
      line(values.json === true ? JSON.stringify(report) : formatFontInstall(report));
      return 0;
    }
    case "list": {
      const fonts = await listInstalledFonts();
      line(values.json === true ? JSON.stringify({ fonts }) : formatFontList(fonts));
      return 0;
    }
    case "uninstall": {
      const families = [...positionals.slice(2), ...(named ?? [])];
      if (families.length === 0) throw new UsageError("fonts uninstall needs a family: assets-scraper fonts uninstall Inter");
      const result = await uninstallFonts(families);
      line(values.json === true ? JSON.stringify(result) : formatFontUninstall(result));
      return 0;
    }
    default:
      throw new UsageError(
        subcommand === undefined ?
          "fonts needs install, list or uninstall: assets-scraper fonts install stripe.com"
        : `unknown fonts command ${JSON.stringify(subcommand)}. It takes install, list or uninstall`,
      );
  }
}

async function runScan(url: string | undefined, values: Values): Promise<number> {
  if (!url) throw new UsageError("scan needs a URL: assets-scraper scan stripe.com");
  // A scan takes no selection, but the flags are still checked here: `scan --profile fast` used to exit 0 in silence, so
  // the typo first said something on the next command that did read it (review issue 14).
  selectionFrom(values);
  const { scan, reused } = await scanPage(scanUrl(url), openSource(values), values);
  const summary = summarize(scan);
  line(values.json === true ? JSON.stringify(summary) : formatSummary(summary, reused));
  return 0;
}

async function runGet(url: string | undefined, values: Values): Promise<number> {
  if (!url) throw new UsageError("get needs a URL: assets-scraper get stripe.com");
  const target = scanUrl(url);
  const source = openSource(values);
  const { scan } = await scanPage(target, source, values);
  const out = asString(values, "out");
  const result = await downloadAssets(scan, source, { ...selectionFrom(values), ...(out === undefined ? {} : { dest: out }) });
  if (values.json === true) line(JSON.stringify({ scanId: scan.scanId, page: scan.page, ...result }));
  else line(`${scan.page.title || scan.page.host} (${scan.page.host})\n${formatDownload(result)}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}. Run assets-scraper --help`);
  }

  if (values.version === true) {
    line(VERSION);
    return 0;
  }
  const command = positionals[0];
  if (values.help === true || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === undefined) {
    process.stderr.write(USAGE);
    return 1;
  }

  switch (command) {
    case "scan":
      return await runScan(positionals[1], values);
    case "get":
      return await runGet(positionals[1], values);
    case "fonts":
      return await runFonts(positionals, values);
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}. Run assets-scraper --help`);
  }
}

/** One line, never a stack: a scan failure keeps its code, so an agent can read what went wrong. */
function report(error: unknown): number {
  const message = error instanceof ScanFailure ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
  process.stderr.write(`assets-scraper: ${message.replace(/\s+/g, " ").trim()}\n`);
  return 1;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await main(argv);
  } catch (error) {
    return report(error);
  }
}

/** True when this file is what node was asked to run, so importing it from a test runs nothing. */
function isEntry(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return fs.realpathSync(argv) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  void run().then((code) => {
    process.exitCode = code;
    // Nothing should hold the loop open once a command is done, and a socket that does must not hang an agent.
    setTimeout(() => process.exit(code), 2_000).unref();
  });
}
