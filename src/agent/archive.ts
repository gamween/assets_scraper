import zlib from "node:zlib";
import type { BrandFileType } from "@/lib/contract";
import { sniffContentType } from "@/server/security/sniff";

/**
 * Reading a brand kit archive: only what it takes to get the logo files out of a ZIP, and nothing a hostile archive
 * could turn against the disk or the process. The archive comes from whatever host a scanned page named, so every number
 * in it is a claim to check, not a size to allocate.
 *
 * - Entries are read from the central directory, and at most `maxEntries` of them: past that the archive is refused.
 * - Only svg, png, pdf, ai and eps files come out. A nested archive is never opened, a symbolic link never written, and
 *   macOS metadata (`__MACOSX/`, `._*`, `.DS_Store`) never kept: monad.xyz's kit holds 52 entries, 7 of them metadata.
 * - A name that is absolute, holds a drive letter, a `..` segment or a control character is refused, not rewritten.
 * - Every file is inflated into a buffer no larger than its declared size, which has to fit `maxFileBytes` and what is
 *   left of `maxTotalBytes` before a byte is inflated, and the declared sizes of every entry tried count against that
 *   total, so a zip bomb (a small stream that inflates without end, or many entries over one stream) costs at most
 *   `maxTotalBytes` of work. A stream that inflates to anything but its declared size, or whose CRC differs, is corrupt.
 * - A file has to be what its extension says, by its first bytes.
 *
 * Methods 0 (stored) and 8 (deflate) are read, which is what every archiver writes by default; ZIP64 sizes and offsets
 * are read too. Encrypted entries and split archives are not.
 */

export interface ArchiveLimits {
  /** Entries of the central directory read, directories and metadata included. More, and the archive is refused. */
  maxEntries: number;
  /** Files one archive gives. */
  maxFiles: number;
  /** Bytes of one file once inflated. */
  maxFileBytes: number;
  /** Bytes all the files tried may inflate to together. */
  maxTotalBytes: number;
}

/** Why an entry of an archive was not written. Directories are not counted: they are not files. */
export type ArchiveSkipReason =
  | "metadata"
  | "other-type"
  | "nested-archive"
  | "symlink"
  | "unsafe-path"
  | "encrypted"
  | "unsupported-compression"
  | "too-large"
  | "over-budget"
  | "cap"
  | "corrupt"
  | "mismatch";

/** A logo file out of an archive: its path inside it, with forward slashes and the common top folder taken off. */
export interface ArchiveFile {
  path: string;
  type: LogoFileType;
  bytes: Buffer;
}

/** The files an archive gives: the logo formats of a brand kit. */
type LogoFileType = Exclude<BrandFileType, "zip">;
const LOGO_TYPES = new Set<string>(["svg", "png", "pdf", "ai", "eps"]);
const NESTED_ARCHIVE = /\.(?:zip|7z|rar|tar|gz|tgz|bz2|xz|zst|jar|sit|sitx|dmg|iso)$/i;
const METADATA_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/** An archive that cannot be read at all: not a ZIP, cut short, split, or too large to list. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
const UNIX_HOST = 3;
const MODE_TYPE = 0o170000;
const MODE_SYMLINK = 0o120000;
/** Path segments one entry may have, and the length of one, once its top folder is off. */
const MAX_DEPTH = 8;
const MAX_SEGMENT_CHARS = 120;

/** True when the bytes start like the kind of file `type` names. An Illustrator file is a PDF or a PostScript file. */
export function looksLike(type: BrandFileType, bytes: Buffer): boolean {
  const head = bytes.subarray(0, 1024).toString("latin1");
  const pdf = head.includes("%PDF-");
  const postscript = head.startsWith("%!PS") || (bytes.length >= 4 && bytes.readUInt32BE(0) === 0xc5d0d3c6);
  switch (type) {
    case "zip":
      return bytes.length >= 4 && (bytes.readUInt32LE(0) === LOCAL || bytes.readUInt32LE(0) === EOCD);
    case "pdf":
      return pdf;
    case "ai":
      return pdf || postscript;
    case "eps":
      return postscript;
    case "svg":
      return sniffContentType(bytes) === "image/svg+xml";
    case "png":
      return sniffContentType(bytes) === "image/png";
  }
}

const safeNumber = (value: bigint, what: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveError(`the archive claims a ${what} too large to read`);
  return Number(value);
};

interface Directory {
  entries: number;
  offset: number;
  size: number;
  /** Where the end records start: the central directory has to end before them, and every file before it. */
  end: number;
}

/** Finds the end of central directory record, and the ZIP64 one it points to when a field overflowed. */
function readDirectory(archive: Buffer): Directory {
  let at = -1;
  for (let position = archive.length - 22; position >= Math.max(0, archive.length - 22 - MAX_COMMENT); position -= 1) {
    if (archive.readUInt32LE(position) === EOCD && position + 22 + archive.readUInt16LE(position + 20) <= archive.length) {
      at = position;
      break;
    }
  }
  if (at === -1) throw new ArchiveError("this is not a ZIP archive, or it was cut short");
  const disk = archive.readUInt16LE(at + 4);
  const directoryDisk = archive.readUInt16LE(at + 6);
  const onDisk = archive.readUInt16LE(at + 8);
  let entries = archive.readUInt16LE(at + 10);
  let size = archive.readUInt32LE(at + 12);
  let offset = archive.readUInt32LE(at + 16);
  let end = at;
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== entries) throw new ArchiveError("this archive is split over several files");
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = at - 20;
    if (locator < 0 || archive.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new ArchiveError("this archive's ZIP64 record is missing");
    const record = safeNumber(archive.readBigUInt64LE(locator + 8), "record offset");
    if (record + 56 > locator || archive.readUInt32LE(record) !== ZIP64_EOCD) throw new ArchiveError("this archive's ZIP64 record is broken");
    entries = safeNumber(archive.readBigUInt64LE(record + 32), "number of entries");
    size = safeNumber(archive.readBigUInt64LE(record + 40), "directory size");
    offset = safeNumber(archive.readBigUInt64LE(record + 48), "directory offset");
    end = record;
  }
  if (offset + size > end) throw new ArchiveError("this archive's directory points past its end");
  return { entries, offset, size, end };
}

interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  symlink: boolean;
}

/** The UTF-8 name when the flag says so or the bytes decode as UTF-8, Latin-1 otherwise. macOS sets no flag. */
function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return utf8Flag ? new TextDecoder("utf-8").decode(bytes) : bytes.toString("latin1");
  }
}

/** The 64 bit sizes and offset of a ZIP64 extra field, for the fields the record left at their maximum. */
function zip64Extra(extra: Buffer, entry: { size: number; compressedSize: number; localOffset: number }): void {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    if (id !== 0x0001) continue;
    let read = 0;
    const next = (what: string) => {
      if (read + 8 > body.length) throw new ArchiveError("this archive's ZIP64 sizes are cut short");
      const value = safeNumber(body.readBigUInt64LE(read), what);
      read += 8;
      return value;
    };
    if (entry.size === 0xffffffff) entry.size = next("file size");
    if (entry.compressedSize === 0xffffffff) entry.compressedSize = next("file size");
    if (entry.localOffset === 0xffffffff) entry.localOffset = next("file offset");
    return;
  }
}

function readEntries(archive: Buffer, directory: Directory, limits: ArchiveLimits): Entry[] {
  if (directory.entries > limits.maxEntries) {
    throw new ArchiveError(`this archive holds ${directory.entries} entries, more than the ${limits.maxEntries} one archive may hold`);
  }
  const entries: Entry[] = [];
  const end = directory.offset + directory.size;
  let at = directory.offset;
  for (let index = 0; index < directory.entries; index += 1) {
    if (at + 46 > end || archive.readUInt32LE(at) !== CENTRAL) throw new ArchiveError("this archive's directory is broken");
    const madeBy = archive.readUInt16LE(at + 4);
    const flags = archive.readUInt16LE(at + 8);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const mode = archive.readUInt32LE(at + 38) >>> 16;
    if (at + 46 + nameLength + extraLength + commentLength > end) throw new ArchiveError("this archive's directory is broken");
    const entry: Entry = {
      name: decodeName(archive.subarray(at + 46, at + 46 + nameLength), (flags & 0x0800) !== 0),
      flags,
      method: archive.readUInt16LE(at + 10),
      crc: archive.readUInt32LE(at + 16),
      compressedSize: archive.readUInt32LE(at + 20),
      size: archive.readUInt32LE(at + 24),
      localOffset: archive.readUInt32LE(at + 42),
      symlink: madeBy >> 8 === UNIX_HOST && (mode & MODE_TYPE) === MODE_SYMLINK,
    };
    zip64Extra(archive.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength), entry);
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * The path segments of an entry name, or null when the name could leave the folder it is written into: absolute, a
 * drive letter, a `..` or `.` segment, a control character, or deeper than anyone nests logos. Backslashes count as
 * separators, as Windows archivers write them.
 */
function rawSegments(name: string): string[] | null {
  const path = name.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-z]:/i.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return null;
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.length === 0 || segments.length > MAX_DEPTH + 1 || segments.some((segment) => segment === ".." || segment === ".") ? null : segments;
}

/** Segments as file names: nothing a file system reads as special, no leading dot, short. Null when one is left empty. */
function cleanSegments(segments: string[]): string[] | null {
  const cleaned = segments.map((segment) => segment.replace(/[:*?"<>|]+/g, "-").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, MAX_SEGMENT_CHARS));
  return cleaned.some((segment) => segment === "") ? null : cleaned;
}

/** macOS resource forks and Finder files, which ride along in every archive Archive Utility makes. */
const isMetadata = (segments: string[]): boolean => {
  const base = segments[segments.length - 1].toLowerCase();
  return segments[0] === "__MACOSX" || base.startsWith("._") || METADATA_NAMES.has(base);
};

/**
 * The entry's bytes, inflated into at most its declared size, or the reason it has none. `zlib` refuses to grow the
 * output past `maxOutputLength`, so a stream that holds more than it declared stops there instead of filling memory.
 */
function inflate(archive: Buffer, entry: Entry, dataEnd: number): Buffer | "corrupt" {
  const at = entry.localOffset;
  if (entry.size === 0) return "corrupt";
  if (at + 30 > dataEnd || archive.readUInt32LE(at) !== LOCAL) return "corrupt";
  const start = at + 30 + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28);
  if (start + entry.compressedSize > dataEnd) return "corrupt";
  const data = archive.subarray(start, start + entry.compressedSize);
  let bytes: Buffer;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) return "corrupt";
    bytes = Buffer.from(data);
  } else {
    try {
      bytes = zlib.inflateRawSync(data, { maxOutputLength: entry.size });
    } catch {
      return "corrupt";
    }
  }
  return bytes.length === entry.size && zlib.crc32(bytes) === entry.crc ? bytes : "corrupt";
}

/**
 * The logo files of an archive, one at a time, so the caller writes each before the next is inflated. `skipped` counts
 * every entry left out, by reason. Throws `ArchiveError` before the first file for an archive it cannot read at all.
 */
export function* logoFilesIn(archive: Buffer, limits: ArchiveLimits, skipped: Partial<Record<ArchiveSkipReason, number>>): Generator<ArchiveFile> {
  const directory = readDirectory(archive);
  const entries = readEntries(archive, directory, limits);
  const skip = (reason: ArchiveSkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  // The checks that need no byte of the file, first: what is left is what the archive offers as logo files.
  const candidates: { entry: Entry; segments: string[]; type: LogoFileType }[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith("/") || entry.name.endsWith("\\")) continue;
    const raw = rawSegments(entry.name);
    const segments = raw === null ? null : cleanSegments(raw);
    if (raw === null || segments === null) skip("unsafe-path");
    else if (isMetadata(raw)) skip("metadata");
    else if (entry.symlink) skip("symlink");
    else if (NESTED_ARCHIVE.test(segments[segments.length - 1])) skip("nested-archive");
    else {
      const type = /\.([a-z0-9]+)$/i.exec(segments[segments.length - 1])?.[1].toLowerCase() ?? "";
      if (!LOGO_TYPES.has(type)) skip("other-type");
      else if ((entry.flags & 0x0001) !== 0) skip("encrypted");
      else if (entry.method !== 0 && entry.method !== 8) skip("unsupported-compression");
      else candidates.push({ entry, segments, type: type as LogoFileType });
    }
  }
  // A kit is usually one folder zipped (`Monad Brand and Media Kit/...`): written into a folder named after the archive,
  // that folder would only be the same name twice.
  const top = candidates[0]?.segments[0];
  const shared = top !== undefined && candidates.every((candidate) => candidate.segments.length > 1 && candidate.segments[0] === top);

  let files = 0;
  let spent = 0;
  for (const { entry, segments, type } of candidates) {
    if (files >= limits.maxFiles) {
      skip("cap");
      continue;
    }
    if (entry.size > limits.maxFileBytes) {
      skip("too-large");
      continue;
    }
    if (spent + entry.size > limits.maxTotalBytes) {
      skip("over-budget");
      continue;
    }
    // Spent before the inflate, whether or not it succeeds: what bounds the work is what was tried, not what was kept.
    spent += entry.size;
    const bytes = inflate(archive, entry, directory.offset);
    if (bytes === "corrupt") {
      skip("corrupt");
      continue;
    }
    if (!looksLike(type, bytes)) {
      skip("mismatch");
      continue;
    }
    files += 1;
    yield { path: (shared ? segments.slice(1) : segments).join("/"), type, bytes };
  }
}
