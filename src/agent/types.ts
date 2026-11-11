import type {
  Asset,
  AssetFormat,
  AssetKind,
  AssetRole,
  AssetSource,
  BrandFile,
  BrandFileType,
  Diagnostics,
  FontFamily,
  FontFile,
  FontLicense,
  Palette,
  ScanStats,
  Wordmark,
} from "@/lib/contract";
import type { ArchiveSkipReason } from "./archive";

/**
 * The agent core contracts (spec `docs/superpowers/specs/2026-09-27-agent-access-design.md`). The CLI, the MCP server
 * and the hosted `/api/v1` routes are adapters over these shapes, so they are the one place a shape changes.
 */

/** One scan, whether it ran locally through the v1 engine or remotely against the hosted app. */
export interface AgentScan {
  scanId: string;
  scannedAt: string; // ISO 8601
  source: "local" | "remote";
  /**
   * The hosted app a remote scan ran against, with no trailing slash, and absent for a local scan. Part of what the
   * scan is an answer to, not a detail of it: two hosted apps are two engines, so the cache tells them apart.
   */
  remote?: string;
  /**
   * `brandLinks` are the page's links to its brand, press or media kit pages and to brand portals on other hosts (spec
   * 8.1), where the official logo variants usually live. `brandFiles` are the files of its kit: archives, guidelines,
   * logo files. `wordmark` is the live text the page sets as its logo, alone or beside a logo asset. Each is absent from
   * a scan that found none, and from a hosted app that predates it.
   */
  page: {
    url: string;
    finalUrl: string;
    host: string;
    title: string;
    siteName?: string;
    brandLinks?: BrandLink[];
    brandFiles?: BrandFile[];
    wordmark?: Wordmark;
  };
  assets: Asset[];
  fonts: FontFamily[];
  palette: Palette | null;
  stats: ScanStats;
  warnings: string[];
  diagnostics?: Diagnostics;
}

export interface ScanSourceOptions {
  /** The hosted app to scan against. `ASSETS_SCRAPER_REMOTE` when left out, and a local scan when neither names one. */
  remote?: string;
  /** Its agent token. `ASSETS_SCRAPER_TOKEN` when left out. */
  token?: string;
  /** The deployment's access code, when it has one. `ASSETS_SCRAPER_ACCESS_CODE` when left out. */
  accessCode?: string;
}

export interface ScanSource {
  readonly kind: "local" | "remote";
  /** The hosted app this source reads, with no trailing slash, and undefined when `kind` is "local". */
  readonly remote?: string;
  scan(url: string, options?: { signal?: AbortSignal; onStep?: (step: string) => void }): Promise<AgentScan>;
  fetchBytes(target: AssetSource | FontFile, options?: FetchBytesOptions): Promise<Buffer>;
}

export interface FetchBytesOptions {
  signal?: AbortSignal;
  /** The page the file was found on, sent as the referrer like the scan's own request for it was. */
  referer?: string;
}

export type SelectionProfile = "deck" | "all";

export interface SelectionOptions {
  profile?: SelectionProfile; // default "deck"
  ids?: string[]; // explicit ids win over every other filter except path safety
  kinds?: AssetKind[];
  roles?: AssetRole[];
  minLongSide?: number; // default from limits
  nameContains?: string;
  includeIcons?: boolean;
  max?: number; // default from limits
  /**
   * Bytes the selection keeps in total, `agentLimits.maxTotalBytes` by default. Raise it to take more, pass 0 to take
   * the whole selection whatever it weighs. Assets named by `ids` are never dropped for it.
   */
  maxTotalBytes?: number;
  /**
   * Bytes one file may take, `agentLimits.maxFileBytes` under the `deck` profile and no ceiling under `all`. Pass 0 to
   * lift it, a number to set your own under either profile.
   */
  maxFileBytes?: number;
}

export type DropReason =
  | "icon"
  | "sprite"
  | "small"
  | "duplicate"
  | "near-duplicate"
  | "vector-preferred"
  | "extra-favicon"
  | "filter"
  | "cap"
  | "too-large"
  | "over-budget"
  | "unavailable";

/** What the byte rules allowed and what they ended up keeping, so a caller can say why a download stopped where it did. */
export interface SelectionBudget {
  /** Bytes the whole selection could take, 0 when the caller lifted the budget. */
  maxTotalBytes: number;
  /** Bytes one file could take, 0 when there is no ceiling. */
  maxFileBytes: number;
  /** Bytes of the kept assets, as far as the selection could measure them: exact once the bytes are in hand. */
  keptBytes: number;
}

export interface Selection {
  keep: Asset[];
  dropped: Partial<Record<DropReason, number>>;
  duplicates: { keptId: string; droppedIds: string[] }[];
  budget: SelectionBudget;
}

export interface DownloadedFile {
  id: string;
  name: string;
  path: string;
  bytes: number;
  kind: AssetKind;
  role: AssetRole;
  width?: number;
  height?: number;
  url: string;
}

export interface DownloadResult {
  dir: string;
  files: DownloadedFile[];
  totalBytes: number;
  dropped: Partial<Record<DropReason, number>>;
  failed: { id: string; name: string; reason: string }[];
  manifestPath: string;
  /** The byte rules this download ran under, and what the kept files weigh against them. */
  budget: SelectionBudget;
}

/** One file a brand file download wrote: the brand file itself, or a logo file out of its archive (`from`). */
export interface BrandDownloadFile {
  /** The brand file's id, the archive's for a file out of one. */
  id: string;
  /** The brand file's name, or the file's path inside the archive. */
  name: string;
  type: BrandFileType;
  path: string;
  bytes: number;
  /** The id of the archive the file came out of. */
  from?: string;
}

/** What one archive gave: the files it wrote and why the rest of its entries were left out. */
export interface BrandArchiveReport {
  id: string;
  name: string;
  files: number;
  skipped: Partial<Record<ArchiveSkipReason, number>>;
  /** Why the archive could not be read at all. It is then written as it is, for an archiver that can. */
  error?: string;
}

export interface BrandDownloadResult {
  /** The `brand` folder of the destination, which every path is inside. */
  dir: string;
  files: BrandDownloadFile[];
  archives: BrandArchiveReport[];
  failed: { id: string; name: string; reason: string }[];
  totalBytes: number;
  manifestPath: string;
}

export interface FontInstall {
  family: string;
  files: string[];
  license: FontLicense;
  sourceHost: string;
  installedAt: string;
  converted: boolean;
}

/** What an agent reads after a scan: counts and a few rows, never the whole asset list (spec 2, context cost). */
interface BrandLink {
  href: string;
  text: string;
}

export interface ScanSummary {
  scanId: string;
  page: Omit<AgentScan["page"], "brandLinks" | "brandFiles" | "wordmark">;
  counts: { assets: number; svg: number; images: number; fonts: number; hidden: number };
  palette: { hex: string; role?: string }[];
  fonts: { family: string; license: FontLicense["kind"]; usedOnPage: boolean; installable: boolean }[];
  /** `format` and `bytes` are there so a 4 MB photo the scan called a logo does not read like a wordmark. */
  logos: { id: string; name: string; kind: AssetKind; format: AssetFormat; width?: number; height?: number; bytes?: number }[];
  /**
   * The live text the page sets as its logo, absent when it has none: the text half of a lockup, whose `withLogo.id` is
   * one of the `logos` rows (or another asset), or a text logo on its own.
   */
  wordmark?: Wordmark;
  /** Where to look next for the official logo variants: the page's brand, press and media kit links. */
  brandLinks: BrandLink[];
  /**
   * The files of the page's brand kit, archives and documents first: what `download_brand_files` takes by `id`. `bytes`
   * is the size the host announced during the scan, when it did.
   */
  brandFiles: { id: string; name: string; type: BrandFileType; bytes?: number; url: string }[];
  /** Brand files the summary had no room for. `download_brand_files` with no ids takes them all. */
  otherBrandFiles: number;
  otherAssets: number;
  warnings: string[];
  durationMs: number;
}
