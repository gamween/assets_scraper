import type { Asset } from "@/lib/contract";
import { extensionFor } from "@/server/scan/post/format";

/**
 * The names a download writes: a host as a directory, an asset as a file. Pure string work, apart from `dest.ts` and
 * `download.ts`, because the hosted routes name their archive and its entries by the same rules and must not load those
 * two modules: their file system calls on paths built from the working directory make the bundler trace the whole
 * repository into every function that imports them.
 */

/** Characters a sanitized host keeps, so it fits a directory name and a cached scan id whatever a page declares. */
export const MAX_HOST_CHARS = 100;

/**
 * A host as a directory name: `www.` off, lower case, punycode kept as it is, nothing that could leave the directory
 * (path separators, colons, `..`), and short enough to be a file name. Empty after that, it becomes `site`.
 */
export function sanitizeHost(host: string): string {
  const safe = host
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, MAX_HOST_CHARS)
    .replace(/[.-]+$/, "");
  return safe || "site";
}

/**
 * One file name from an asset: the last path segment only, so a name like `../../evil.svg` cannot walk anywhere, and
 * nothing a file system reads as special. `createFileInside` checks the result again, this only keeps names readable.
 */
export function safeFileName(value: string, fallback: string): string {
  const last = value.split(/[\\/]/).pop() ?? "";
  const cleaned = last
    .replace(/[\x00-\x1f\x7f:*?"<>|]+/g, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * The file name an asset is written under, in the archive as on disk: the scan's name for it, cleaned by
 * `safeFileName`, with the extension of its format. The extension is never the one the scan's file name carries: a
 * remote answer names the file, and `Open me.terminal` holding a PNG must not land as something the system would open
 * as a program. A local scan names files `<slug>.<format>` anyway, so this changes nothing for it.
 */
export function assetFileName(asset: Asset): string {
  const extension = extensionFor(asset.format);
  const fallback = `${asset.id}.${extension}`;
  const name = safeFileName(asset.filename || asset.name || fallback, fallback);
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

/**
 * `name`, then `stem-2.ext`, `stem-3.ext` and so on: the names one file tries in turn, compared without case (spec 4).
 * macOS and Windows file systems do not tell `Logo.svg` from `logo.svg`, so neither does the rule, whether the files go
 * to a disk or into an archive that will be unzipped on one.
 */
export function* nameCandidates(name: string): Generator<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  yield name;
  for (let attempt = 2; ; attempt += 1) yield `${stem}-${attempt}${extension}`;
}

/** The first candidate of `name` that `used` does not hold yet, which it then does. The archive's side of the rule. */
export function uniqueName(name: string, used: Set<string>): string {
  for (const candidate of nameCandidates(name)) {
    if (used.has(candidate.toLowerCase())) continue;
    used.add(candidate.toLowerCase());
    return candidate;
  }
  throw new Error("unreachable: the candidates never end");
}
