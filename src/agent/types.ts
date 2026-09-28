import type {
  Asset,
  AssetKind,
  AssetRole,
  AssetSource,
  Diagnostics,
  FontFamily,
  FontFile,
  FontLicense,
  Palette,
  ScanStats,
} from "@/lib/contract";

/**
 * The agent core contracts (spec `docs/superpowers/specs/2026-09-27-agent-access-design.md`). The CLI, the MCP server
 * and the hosted `/api/v1` routes are adapters over these shapes, so they are the one place a shape changes.
 */

/** One scan, whether it ran locally through the v1 engine or remotely against the hosted app. */
export interface AgentScan {
  scanId: string;
  scannedAt: string; // ISO 8601
  source: "local" | "remote";
  page: { url: string; finalUrl: string; host: string; title: string; siteName?: string };
  assets: Asset[];
  fonts: FontFamily[];
  palette: Palette | null;
  stats: ScanStats;
  warnings: string[];
  diagnostics?: Diagnostics;
}

export interface ScanSourceOptions {
  remote?: string;
  token?: string;
}

export interface ScanSource {
  readonly kind: "local" | "remote";
  scan(url: string, options?: { signal?: AbortSignal; onStep?: (step: string) => void }): Promise<AgentScan>;
  fetchBytes(target: AssetSource | FontFile, options?: { signal?: AbortSignal }): Promise<Buffer>;
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
  | "unavailable";

export interface Selection {
  keep: Asset[];
  dropped: Partial<Record<DropReason, number>>;
  duplicates: { keptId: string; droppedIds: string[] }[];
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
export interface ScanSummary {
  scanId: string;
  page: AgentScan["page"];
  counts: { assets: number; svg: number; images: number; fonts: number; hidden: number };
  palette: { hex: string; role?: string }[];
  fonts: { family: string; license: FontLicense["kind"]; usedOnPage: boolean; installable: boolean }[];
  logos: { id: string; name: string; kind: AssetKind; width?: number; height?: number }[];
  otherAssets: number;
  warnings: string[];
  durationMs: number;
}
