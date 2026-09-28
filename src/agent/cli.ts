import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pkg from "../../package.json";
import { AssetKind, AssetRole } from "@/lib/contract";
import { formatBytes, formatCount, formatDimensions, formatDuration } from "@/lib/format";
import { normalizeInputUrl } from "@/lib/url";
import { ScanFailure } from "@/server/errors";
import { findRecentScan, saveScan } from "./cache";
import { downloadAssets } from "./download";
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

Options
  --out DIR             Where to write. Default: <project root>/scrap/<host>, or ~/Downloads/assets-scraper/<host>
  --profile deck|all    deck (default) drops icons, thumbnails, small images and duplicates. all keeps everything
  --kind svg,image      Only these kinds
  --role logo,site-logo Only these roles
  --min-long-side 600   Drop a raster whose longest side is under this, logos and favicons excepted
  --max 60              Files one download writes, highest scoring first
  --name-contains TEXT  Only assets whose name holds TEXT
  --include-icons       Keep icons the deck profile would drop
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
 * The URL to scan, read the way the app reads what a user pastes, so `stripe.com` works like the spec's examples and the
 * cache sees one form of each page.
 *
 * A port outside 80 and 443 is not refused here: that policy belongs to the scan, which also knows the test allowlist,
 * so such a URL is passed through for the engine to answer with its own `unsupported-port`. The error this does throw
 * carries the v1 code, so an agent reading stderr gets the vocabulary the API uses.
 */
export function scanUrl(raw: string): string {
  const parsed = normalizeInputUrl(raw);
  if (parsed.ok) return parsed.url;
  const trimmed = raw.trim();
  if (parsed.code === "unsupported-port") {
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).toString();
    } catch {
      // Not a URL after all, so it fails as one below.
    }
  }
  throw new UsageError(`invalid-url: ${JSON.stringify(raw)} is not a web address`);
}

/** Where the scan runs (spec 2): the hosted app when `--remote`, `--remote-url` or `ASSETS_SCRAPER_REMOTE` names one. */
export function openSource(values: Values): ScanSource {
  const named = asString(values, "remote-url")?.trim() || process.env.ASSETS_SCRAPER_REMOTE?.trim() || "";
  const remote = named || (values.remote === true ? DEFAULT_REMOTE : "");
  if (remote === "") return createLocalScanSource();
  const token = asString(values, "token");
  return createRemoteScanSource({ remote, ...(token === undefined ? {} : { token }) });
}

/** The scan of `url` from the cache when one is fresh (spec 6), otherwise a new one, saved for the next command. */
async function scanPage(url: string, source: ScanSource, values: Values): Promise<{ scan: AgentScan; reused: boolean }> {
  if (values.refresh !== true) {
    const cached = await findRecentScan(url);
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
      rows.push(`    ${logo.id}  ${logo.name}  ${logo.kind}  ${formatDimensions(logo.width, logo.height) || "size unknown"}`);
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

async function runScan(url: string | undefined, values: Values): Promise<number> {
  if (!url) throw new UsageError("scan needs a URL: assets-scraper scan stripe.com");
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
      // Font installation is the MCP track (plan Task G3.1). It is wired in here when `src/agent/fonts.ts` lands.
      throw new UsageError("fonts commands need the font installer, which is not in this build yet");
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
