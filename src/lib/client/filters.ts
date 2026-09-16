import type { Asset, FontFamily } from "@/lib/contract";

export type Tab = "all" | "svg" | "images" | "fonts";
export const TABS: readonly Tab[] = ["all", "svg", "images", "fonts"];

export type SortKey = "relevance" | "page-order" | "largest" | "file-size" | "name";
export const SORT_KEYS: readonly SortKey[] = ["relevance", "page-order", "largest", "file-size", "name"];

export type Background = "auto" | "light" | "dark" | "grid";
export const BACKGROUNDS: readonly Background[] = ["auto", "light", "dark", "grid"];

export type AssetSectionId = "logos" | "svg" | "images" | "small-icons" | "stylesheets" | "public-sources";
export type FontSectionId = "fonts" | "declared-fonts";
export type SectionId = AssetSectionId | FontSectionId;

export interface AssetSection {
  id: AssetSectionId;
  kind: "assets";
  title: string;
  items: Asset[];
  collapsible: boolean;
}

export interface FontSection {
  id: FontSectionId;
  kind: "fonts";
  title: string;
  items: FontFamily[];
  collapsible: boolean;
}

export type Section = AssetSection | FontSection;

export const SECTION_TITLES: Record<SectionId, string> = {
  logos: "Logos",
  svg: "SVG",
  images: "Images",
  fonts: "Fonts",
  "small-icons": "Small icons",
  stylesheets: "In stylesheets",
  "declared-fonts": "Declared, not used",
  "public-sources": "From public sources",
};

/** Sections that start collapsed and whose items stay out of select-all and Download all until expanded. */
export const COLLAPSIBLE_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>(["small-icons", "stylesheets", "declared-fonts"]);

export interface FilterOptions {
  tab: Tab;
  query: string;
  sort: SortKey;
}

export type Item = { kind: "asset"; key: string; asset: Asset } | { kind: "font"; key: string; font: FontFamily };

export const assetKey = (id: string) => `asset:${id}`;
export const fontKey = (id: string) => `font:${id}`;

const LOGO_ROLES = new Set<Asset["role"]>(["site-logo", "logo", "favicon"]);
const EXEMPT_FROM_SMALL = new Set<Asset["role"]>(["site-logo", "logo", "favicon", "social"]);
const SMALL_ICON_MAX = 48;

export const isLogo = (asset: Asset) => LOGO_ROLES.has(asset.role);

/**
 * Spec 8.5, the single small-icon rule: longest rendered side <= 48 CSS px, or intrinsic side <= 48 px when the asset
 * was not rendered. Logo, favicon and social roles are exempt. The server already assigns `icon` with this rule.
 */
export function isSmallIcon(asset: Asset): boolean {
  if (EXEMPT_FROM_SMALL.has(asset.role)) return false;
  if (asset.role === "icon") return true;
  const rendered = asset.renderedWidth && asset.renderedHeight ? Math.max(asset.renderedWidth, asset.renderedHeight) : 0;
  if (rendered > 0) return rendered <= SMALL_ICON_MAX;
  const intrinsic = asset.width && asset.height ? Math.max(asset.width, asset.height) : 0;
  return intrinsic > 0 && intrinsic <= SMALL_ICON_MAX;
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function assetMatches(asset: Asset, query: string): boolean {
  if (!query) return true;
  return [asset.name, asset.filename, asset.display?.url, asset.original?.url].some((value) => value?.toLowerCase().includes(query));
}

export function fontMatches(font: FontFamily, query: string): boolean {
  if (!query) return true;
  const values = [font.name, font.googleFamily, ...font.cssFamilies, ...font.faces.flatMap((face) => face.files.map((file) => file.url))];
  return values.some((value) => value?.toLowerCase().includes(query));
}

const area = (asset: Asset) => {
  const width = asset.original?.width ?? asset.width ?? 0;
  const height = asset.original?.height ?? asset.height ?? 0;
  return width * height;
};

export const assetBytes = (asset: Asset) => asset.original?.bytes ?? asset.bytes ?? asset.display?.bytes ?? 0;

export const fontBytes = (font: FontFamily) =>
  font.faces.reduce((sum, face) => sum + face.files.reduce((total, file) => total + (file.bytes ?? 0), 0), 0);

const byRelevance = (a: Asset, b: Asset) => b.score - a.score || a.order - b.order;
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

const ASSET_SORTS: Record<SortKey, (a: Asset, b: Asset) => number> = {
  relevance: byRelevance,
  "page-order": (a, b) => a.order - b.order,
  largest: (a, b) => area(b) - area(a) || byRelevance(a, b),
  "file-size": (a, b) => assetBytes(b) - assetBytes(a) || byRelevance(a, b),
  name: (a, b) => collator.compare(a.name, b.name) || a.order - b.order,
};

function sortAssets(assets: Asset[], sort: SortKey, socialFirst = false): Asset[] {
  const sorted = [...assets].sort(ASSET_SORTS[sort]);
  if (!socialFirst) return sorted;
  // Spec 12.2: social images lead the Images section whatever the sort.
  return [...sorted.filter((asset) => asset.role === "social"), ...sorted.filter((asset) => asset.role !== "social")];
}

function sortFonts(fonts: FontFamily[], sort: SortKey): FontFamily[] {
  const indexed = fonts.map((font, index) => ({ font, index }));
  const byUsage = (a: { font: FontFamily; index: number }, b: { font: FontFamily; index: number }) =>
    b.font.usage - a.font.usage || a.index - b.index;
  const compare: Record<SortKey, typeof byUsage> = {
    relevance: byUsage,
    largest: byUsage,
    "page-order": (a, b) => a.index - b.index,
    "file-size": (a, b) => fontBytes(b.font) - fontBytes(a.font) || byUsage(a, b),
    name: (a, b) => collator.compare(a.font.name, b.font.name) || a.index - b.index,
  };
  return indexed.sort(compare[sort]).map((entry) => entry.font);
}

function assetSection(id: AssetSectionId, items: Asset[], sort: SortKey): AssetSection | null {
  if (!items.length) return null;
  return { id, kind: "assets", title: SECTION_TITLES[id], items: sortAssets(items, sort, id === "images"), collapsible: COLLAPSIBLE_SECTIONS.has(id) };
}

function fontSection(id: FontSectionId, items: FontFamily[], sort: SortKey): FontSection | null {
  if (!items.length) return null;
  return { id, kind: "fonts", title: SECTION_TITLES[id], items: sortFonts(items, sort), collapsible: COLLAPSIBLE_SECTIONS.has(id) };
}

/** Spec 12.2: the sections of a tab, in display order, without empty sections. */
export function sectionize(assets: Asset[], fonts: FontFamily[], options: FilterOptions): Section[] {
  const query = normalizeQuery(options.query);
  const matching = assets.filter((asset) => assetMatches(asset, query));
  const matchingFonts = options.tab === "all" || options.tab === "fonts" ? fonts.filter((font) => fontMatches(font, query)) : [];

  const inTab =
    options.tab === "svg"
      ? matching.filter((asset) => asset.kind === "svg")
      : options.tab === "images"
        ? matching.filter((asset) => asset.kind === "image")
        : options.tab === "fonts"
          ? []
          : matching;

  const logos: Asset[] = [];
  const svg: Asset[] = [];
  const images: Asset[] = [];
  const small: Asset[] = [];
  const declared: Asset[] = [];
  for (const asset of inTab) {
    if (options.tab === "all" && isLogo(asset)) logos.push(asset);
    else if (asset.declaredOnly) declared.push(asset);
    else if (isSmallIcon(asset)) small.push(asset);
    else if (asset.kind === "svg") svg.push(asset);
    else images.push(asset);
  }

  const sections = [
    assetSection("logos", logos, options.sort),
    assetSection("svg", svg, options.sort),
    assetSection("images", images, options.sort),
    fontSection("fonts", matchingFonts.filter((font) => font.usedOnPage), options.sort),
    assetSection("small-icons", small, options.sort),
    assetSection("stylesheets", declared, options.sort),
    fontSection("declared-fonts", matchingFonts.filter((font) => !font.usedOnPage), options.sort),
  ];
  return sections.filter((section): section is Section => section !== null);
}

/** Blocked or not-html scans: the fallback assets in one section, in server order. */
export function publicSourcesSection(assets: Asset[], options: Pick<FilterOptions, "query" | "sort">): Section[] {
  const query = normalizeQuery(options.query);
  const items = assets.filter((asset) => assetMatches(asset, query));
  return items.length ? [{ id: "public-sources", kind: "assets", title: SECTION_TITLES["public-sources"], items: sortAssets(items, options.sort), collapsible: false }] : [];
}

export function findSection(sections: Section[], id: AssetSectionId): AssetSection | undefined;
export function findSection(sections: Section[], id: FontSectionId): FontSection | undefined;
export function findSection(sections: Section[], id: SectionId): Section | undefined {
  return sections.find((section) => section.id === id);
}

export function tabCounts(assets: Asset[], fonts: FontFamily[], query: string): Record<Tab, number> {
  const normalized = normalizeQuery(query);
  let svg = 0;
  let images = 0;
  for (const asset of assets) {
    if (!assetMatches(asset, normalized)) continue;
    if (asset.kind === "svg") svg += 1;
    else images += 1;
  }
  const fontCount = fonts.filter((font) => fontMatches(font, normalized)).length;
  return { all: svg + images + fontCount, svg, images, fonts: fontCount };
}

/** Items in visual order, as rendered: collapsed sections contribute nothing. */
export function visibleItems(sections: Section[], expanded: ReadonlySet<SectionId>): Item[] {
  const items: Item[] = [];
  for (const section of sections) {
    if (section.collapsible && !expanded.has(section.id)) continue;
    if (section.kind === "assets") for (const asset of section.items) items.push({ kind: "asset", key: assetKey(asset.id), asset });
    else for (const font of section.items) items.push({ kind: "font", key: fontKey(font.id), font });
  }
  return items;
}
