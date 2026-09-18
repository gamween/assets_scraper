import { readFileSync } from "node:fs";
import path from "node:path";
import type { Asset, Diagnostics, FontFamily, ScanEvent } from "../../src/lib/contract";

/**
 * NDJSON fixtures built from the 2026-09-16 lab scans of linear.app, stripe.com and framer.com, converted to the
 * contract. Remote URLs point to https://e2e.test/e2e-assets/..., which the routes in ./routes.ts serve offline.
 */
export type FixtureName = "linear" | "stripe" | "framer";

const FIXTURES = path.join(__dirname, "..", "fixtures");

export function loadFixture(name: FixtureName): ScanEvent[] {
  return readFileSync(path.join(FIXTURES, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ScanEvent);
}

export const toNdjson = (events: ScanEvent[]) => events.map((event) => `${JSON.stringify(event)}\n`).join("");

export const assetsOf = (events: ScanEvent[]): Asset[] => events.flatMap((event) => (event.type === "assets" ? event.items : []));

export const fontsOf = (events: ScanEvent[]): FontFamily[] => events.flatMap((event) => (event.type === "fonts" ? event.families : []));

export function findAsset(events: ScanEvent[], predicate: (asset: Asset) => boolean): Asset {
  const asset = assetsOf(events).find(predicate);
  if (!asset) throw new Error("No fixture asset matches");
  return asset;
}

/** Returns events with every asset passed through `update` (same batches, same order). */
export function mapAssets(events: ScanEvent[], update: (asset: Asset) => Asset | null): ScanEvent[] {
  return events.map((event) =>
    event.type === "assets" ? { ...event, items: event.items.map(update).filter((asset): asset is Asset => asset !== null) } : event,
  );
}

export function withFonts(events: ScanEvent[], families: FontFamily[]): ScanEvent[] {
  return events.map((event) => (event.type === "fonts" ? { ...event, families } : event));
}

export function withDone(events: ScanEvent[], update: (done: Extract<ScanEvent, { type: "done" }>) => Extract<ScanEvent, { type: "done" }>): ScanEvent[] {
  return events.map((event) => (event.type === "done" ? update(event) : event));
}

export const diagnostics: Diagnostics = {
  scanId: "e2e-scan-7f3a",
  cold: true,
  phases: { preflight: 300 },
  queueMs: 0,
  egress: { bytes: 0, blocked: 0, refused: 0 },
  bodyTimeouts: 0,
  skippedBodies: 0,
  collector: "isolated",
  version: "e2e",
};

/** Served bytes for each fixture font path (files of the fixture site). */
export function fontFileFor(pathname: string): string | null {
  const map = JSON.parse(readFileSync(path.join(FIXTURES, "font-files.json"), "utf8")) as Record<string, string>;
  return map[pathname] ? path.join(__dirname, "..", "..", "tests", "fixtures", "site", "assets", map[pathname]) : null;
}
