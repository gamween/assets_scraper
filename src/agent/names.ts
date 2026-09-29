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
