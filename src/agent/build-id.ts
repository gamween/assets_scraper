import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json";

/**
 * Which build wrote a thing (spec 6, the scan cache). A cached scan is an answer this code produced, so an answer from
 * another build is not one this build can stand behind: an upgrade that changes what a scan finds, or what the
 * selection keeps, would otherwise be invisible for an hour while the cache serves the old build's results, which is
 * exactly the hour someone spends wondering why a fix did nothing.
 *
 * The identity is the package version plus the bytes of the bundles the command is running from, so any rebuild of
 * `dist/` mints a new one. `cli.mjs` and `mcp.mjs` sit in that directory together and hash it together, which is what
 * keeps the CLI and the MCP server reading each other's scans: they are one build, so they are one identity.
 *
 * Running from source (vitest, tsx, the Next server) has no bundles to hash and says so rather than pretending to a
 * build number. `ASSETS_SCRAPER_BUILD_ID` overrides everything, which is the seam a test writes two identities through.
 */

const VERSION: string = pkg.version;

/** The bundles a run is made of: the `.mjs` files next to the running module, or none when it runs from source. */
function bundleHash(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".mjs")).sort();
  } catch {
    return "source";
  }
  if (names.length === 0) return "source";
  const hash = createHash("sha256");
  for (const name of names) {
    try {
      hash.update(name).update(fs.readFileSync(path.join(dir, name)));
    } catch {
      // A bundle being rewritten under us is not this run's build: skipping it changes the digest, which is the
      // honest answer rather than a stale one.
      hash.update(name).update("unreadable");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

let cached: string | null = null;

/**
 * The identity of the build this process is, as one short string. The bundle digest is read once per process: it is a
 * megabyte of reads, and the files cannot change under a process that has already loaded them.
 */
export function buildIdentity(): string {
  const named = process.env.ASSETS_SCRAPER_BUILD_ID?.trim();
  if (named) return named;
  return (cached ??= `${VERSION}+${bundleHash()}`);
}
