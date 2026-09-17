// Scans the reference sites through a running app and writes one JSON per site plus a summary table.
//   OPS_TOKEN=... node scripts/scan-sites.mjs --base http://localhost:3201 --out ../reference-scans/run1
//   OPS_TOKEN=... node scripts/scan-sites.mjs --sites stripe.com,linear.app
// The ops token skips the bot check and the rate limit (spec 11.1), so the scans are not throttled.
// Keep --out outside the repo; the default scan-results/ is git ignored. Exits 1 when a site ends without a scan
// result, except for a site listed in --expect-blocked (g2.com by default) that ends on a blocked error: that block
// is permanent and by design, so it does not hide a run where the server died halfway.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The 23 reference sites of the discovery lab, in the order of its table. */
const SITES = [
  "allbirds.com", "apple.com", "binance.com", "chain.link", "coinbase.com", "framer.com",
  "g2.com", "gatsbyjs.com", "gymshark.com", "ilovechickpea.ca", "linear.app", "medium.com",
  "notion.com", "porsche.com", "ripple.com", "sanity.io", "squarespace.com", "stripe.com",
  "techcrunch.com", "uniswap.org", "vercel.com", "webflow.com", "xrpl.org",
];

/** Sites that answer every automated client with a challenge page: their blocked error is the expected outcome. */
const EXPECTED_BLOCKED = ["g2.com"];

const DEFAULTS = { base: "http://localhost:3000", out: "scan-results", timeout: 180_000, retries: 1 };
const FLAGS = new Set(["--base", "--out", "--sites", "--timeout", "--retries", "--expect-blocked"]);

const list = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);

export function parseArgs(argv) {
  const options = { ...DEFAULTS, sites: SITES, expectBlocked: EXPECTED_BLOCKED };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (!FLAGS.has(flag)) throw new Error(`Unknown option ${flag}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--base") options.base = value.replace(/\/+$/, "");
    else if (flag === "--out") options.out = value;
    else if (flag === "--sites") options.sites = list(value);
    // An empty --expect-blocked is meaningful, unlike an empty --sites: it means no failure is expected.
    else if (flag === "--expect-blocked") options.expectBlocked = list(value);
    else if (flag === "--timeout") options.timeout = Number(value);
    else options.retries = Number(value);
  }
  if (!options.sites.length) throw new Error("--sites must name at least one site");
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error("--timeout must be a positive number of milliseconds");
  if (!Number.isFinite(options.retries) || options.retries < 0) throw new Error("--retries must be zero or more");
  return options;
}

/** Yields one parsed event per NDJSON line; a line that is not JSON is reported and skipped. */
async function* readEvents(response, onBadLine) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n");
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) {
        try {
          yield JSON.parse(line);
        } catch {
          onBadLine(line.slice(0, 200));
        }
      }
      cut = buffer.indexOf("\n");
    }
  }
  const last = (buffer + decoder.decode()).trim();
  if (last) {
    try {
      yield JSON.parse(last);
    } catch {
      onBadLine(last.slice(0, 200));
    }
  }
}

/** POSTs one scan and collects every event. Network and HTTP failures come back as a result, never as a throw. */
async function scanSite(site, options) {
  const url = `https://${site}/`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout);
  const collected = { events: [], assets: [], fonts: [], pages: [], warnings: [], palette: undefined, done: null, error: null, badLines: [] };
  try {
    const response = await fetch(`${options.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.OPS_TOKEN ? { "x-ops-token": process.env.OPS_TOKEN } : {}) },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      collected.http = { status: response.status, code: parsed?.error?.code ?? null, message: parsed?.error?.message ?? body.slice(0, 200) };
      return { site, url, wallMs: Date.now() - started, ...collected };
    }
    for await (const event of readEvents(response, (line) => collected.badLines.push(line))) {
      collected.events.push(event.type);
      if (event.type === "assets") collected.assets.push(...event.items);
      else if (event.type === "fonts") collected.fonts.push(...event.families);
      else if (event.type === "page") collected.pages.push(event.page);
      else if (event.type === "palette") collected.palette = event.palette;
      else if (event.type === "warning") collected.warnings.push({ code: event.code, detail: event.detail });
      else if (event.type === "done") collected.done = event;
      else if (event.type === "error") collected.error = event;
    }
  } catch (cause) {
    collected.transport = controller.signal.aborted ? `timeout after ${options.timeout} ms` : String(cause?.message ?? cause);
  } finally {
    clearTimeout(timer);
  }
  return { site, url, wallMs: Date.now() - started, ...collected };
}

const sum = (record) => Object.values(record ?? {}).reduce((total, count) => total + count, 0);

/** One row of the summary table, plus everything the comparison with the lab needs. */
export function summarize(result) {
  const done = result.done;
  const page = result.pages.at(-1) ?? null;
  const logos = result.assets.filter((asset) => asset.role === "site-logo");
  const fallback = result.error?.fallback ?? [];
  const status = result.transport ? "transport" : result.http ? `http-${result.http.status}` : result.error ? "error" : done ? (done.partial ? "partial" : "done") : "truncated";
  return {
    site: result.site,
    url: result.url,
    status,
    wallMs: result.wallMs,
    durationMs: done?.stats?.durationMs ?? null,
    finalUrl: page?.finalUrl ?? null,
    httpStatus: page?.status ?? result.error?.httpStatus ?? result.http?.status ?? null,
    title: page?.title ?? null,
    counts: {
      assets: done?.stats?.assets ?? result.assets.length,
      svg: done?.stats?.svg ?? result.assets.filter((asset) => asset.kind === "svg").length,
      images: done?.stats?.images ?? result.assets.filter((asset) => asset.kind === "image").length,
      fonts: done?.stats?.fonts ?? result.fonts.length,
      fontFamiliesUsed: result.fonts.filter((family) => family.usedOnPage).length,
      inlineSvg: result.assets.filter((asset) => asset.inline && "text" in asset.inline).length,
      fallback: fallback.length,
    },
    roles: Object.fromEntries(Object.entries(result.assets.reduce((tally, asset) => ({ ...tally, [asset.role]: (tally[asset.role] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])),
    siteLogo: logos.length
      ? { count: logos.length, name: logos[0].name, kind: logos[0].kind, foundIn: logos[0].foundIn, width: logos[0].width ?? null, height: logos[0].height ?? null }
      : null,
    palette: result.palette ? { brand: result.palette.brand.map((swatch) => swatch.hex), neutrals: result.palette.neutrals.map((swatch) => swatch.hex) } : null,
    hidden: done?.stats?.hidden ?? {},
    hiddenTotal: sum(done?.stats?.hidden),
    partial: done?.partial ?? null,
    warnings: result.warnings,
    error: result.error ? { code: result.error.code, message: result.error.message } : result.http ? { code: result.http.code, message: result.http.message } : result.transport ? { code: "transport", message: result.transport } : null,
    diagnostics: done?.diagnostics ?? result.error?.diagnostics ?? null,
    badLines: result.badLines,
    events: result.events.reduce((tally, type) => ({ ...tally, [type]: (tally[type] ?? 0) + 1 }), {}),
  };
}

const trimAsset = (asset) => ({
  id: asset.id, kind: asset.kind, role: asset.role, name: asset.name, format: asset.format, foundIn: asset.foundIn,
  visible: asset.visible, declaredOnly: asset.declaredOnly, score: asset.score, usedCount: asset.usedCount, tone: asset.tone,
  width: asset.width ?? null, height: asset.height ?? null, bytes: asset.bytes ?? null,
  url: asset.original?.url ?? asset.display?.url ?? (asset.inline ? "inline" : null),
});

/** Assets and fonts without their bytes: enough to compare with the lab, small enough to read. */
const details = (result) => ({
  assets: result.assets.map(trimAsset),
  fallbackAssets: (result.error?.fallback ?? []).map(trimAsset),
  fonts: result.fonts.map((family) => ({
    name: family.name, source: family.source, sourceHost: family.sourceHost ?? null, license: family.license.kind,
    usedOnPage: family.usedOnPage, usage: family.usage, downloadable: family.downloadable, convertible: family.convertible,
    faces: family.faces.length, files: family.faces.reduce((total, face) => total + face.files.length, 0),
    loadedFaces: family.faces.filter((face) => face.loaded).length,
  })),
  brandLinks: result.pages.at(-1)?.brandLinks ?? [],
});

const COLUMNS = [
  ["site", (row) => row.site],
  ["status", (row) => row.status],
  ["ms", (row) => String(row.durationMs ?? row.wallMs)],
  ["svg", (row) => String(row.counts.svg)],
  ["img", (row) => String(row.counts.images)],
  ["fonts", (row) => String(row.counts.fonts)],
  ["logo", (row) => (row.siteLogo ? `yes (${row.siteLogo.name})` : "no")],
  ["brand", (row) => (row.palette?.brand.length ? row.palette.brand.slice(0, 3).join(" ") : "-")],
  ["hidden", (row) => String(row.hiddenTotal)],
  ["partial", (row) => (row.partial === null ? "-" : String(row.partial))],
  ["error", (row) => row.error?.code ?? "-"],
];

function table(rows) {
  const body = rows.map((row) => COLUMNS.map(([, read]) => read(row)));
  const widths = COLUMNS.map(([name], index) => Math.max(name.length, ...body.map((cells) => cells[index].length)));
  const line = (cells) => `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;
  return [line(COLUMNS.map(([name]) => name)), `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`, ...body.map(line)].join("\n");
}

/** A scan that never reached the page, or whose stream died early, is worth one more try; a real scan result is not. */
export const shouldRetry = (summary) => ["transport", "truncated"].includes(summary.status) || ["busy", "internal", "dns", "connect"].includes(summary.error?.code);

/**
 * Whether a row means the run went wrong. A site listed in `expectBlocked` is allowed exactly one outcome besides a
 * scan result, its blocked error: any other failure on it still counts, so the exit code keeps its meaning.
 */
export const isFailure = (row, expectBlocked = EXPECTED_BLOCKED) =>
  !["done", "partial"].includes(row.status) && !(row.error?.code === "blocked" && expectBlocked.includes(row.site));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.OPS_TOKEN) console.warn("OPS_TOKEN is not set: scans go through the bot check, the rate limit and the daily budget.");
  await mkdir(options.out, { recursive: true });
  const startedAt = new Date().toISOString();
  const rows = [];
  for (const site of options.sites) {
    let result = await scanSite(site, options);
    let summary = summarize(result);
    for (let attempt = 0; attempt < options.retries && shouldRetry(summary); attempt += 1) {
      console.log(`${site}: ${summary.error?.code ?? summary.status}, retrying`);
      result = await scanSite(site, options);
      summary = summarize(result);
    }
    rows.push(summary);
    await writeFile(path.join(options.out, `${site}.json`), `${JSON.stringify({ ...summary, ...details(result) }, null, 2)}\n`);
    console.log(`${site.padEnd(18)} ${summary.status.padEnd(9)} ${String(summary.durationMs ?? summary.wallMs).padStart(6)} ms  svg ${summary.counts.svg}  img ${summary.counts.images}  fonts ${summary.counts.fonts}  logo ${summary.siteLogo ? "yes" : "no"}  ${summary.error?.code ?? ""}`);
  }
  const rendered = table(rows);
  await writeFile(path.join(options.out, "summary.json"), `${JSON.stringify({ base: options.base, startedAt, finishedAt: new Date().toISOString(), rows }, null, 2)}\n`);
  await writeFile(path.join(options.out, "summary.md"), `${rendered}\n`);
  console.log(`\n${rendered}\n\nWrote ${rows.length} results to ${path.resolve(options.out)}`);
  const blocked = rows.filter((row) => !isFailure(row, options.expectBlocked) && row.status !== "done" && row.status !== "partial");
  if (blocked.length) console.log(`Blocked as expected: ${blocked.map((row) => row.site).join(", ")}`);
  const failures = rows.filter((row) => isFailure(row, options.expectBlocked));
  if (failures.length) {
    console.log(`Sites without a scan result: ${failures.map((row) => `${row.site} (${row.error?.code ?? row.status})`).join(", ")}`);
    process.exitCode = 1;
  }
}

// Imported by the tests, run as a script otherwise.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
