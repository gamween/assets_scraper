import type { FontFaceInfo, FontFamily, FontFile, FontFormat } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { SignLimitError } from "@/server/security/sign";
import type { CapturedFont, FontBinaryMeta, FontsOutput, PostInput, RawFontFaceRule, RawFontUsage, SafeFetch, Signer } from "../types";
import { normalizeStretch, normalizeStyle, normalizeWeight, parseFontFaceCss } from "./css";
import { createFileLookup, isDataUri, remoteUrl, type FileRecord } from "./files";
import { matchGoogleFamilies } from "./google";
import { classifyLicense } from "./license";
import { binaryFamilyName, cleanCssFamily, GENERIC_FAMILIES, resolveFamilyName, splitFamilies } from "./names";
import { coversBasicLatin } from "./unicode";

export { parseFontBinary } from "./binary";
export { parseFontFaceCss } from "./css";

/**
 * Bounds on what a hostile page can make this module do: grouping is synchronous, where neither the scan deadline nor
 * an abort signal can stop it, and the collector output and captured stylesheets can declare anything. The `data:`
 * URI font bounds are in `files.ts`.
 * - `@font-face` rules read from the CSSOM, and again from captured stylesheets. Pages with the most rules, CJK fonts
 *   split in about 100 `unicode-range` subsets per weight, have a few thousand.
 * - Families `document.fonts` registered without a rule, and binary names of captured files without a rule: each name
 *   is matched against each family.
 */
const MAX_RULES_PER_SOURCE = 5_000;
const MAX_REGISTERED_FAMILIES = 128;
const MAX_UNDECLARED_NAMES = 128;

/**
 * Whether a font file may be converted to TTF (the asset proxy `fmt=ttf`, spec 9 and 11.2): an open licence in its
 * name records, or no licence text at all and a family name that Google Fonts knows. A commercial licence or an
 * unreadable file never converts.
 */
export async function isConvertibleFont(meta: FontBinaryMeta | null, options: { fetch: SafeFetch; signal: AbortSignal }): Promise<boolean> {
  if (!meta) return false;
  const { kind } = classifyLicense(meta);
  if (kind !== "unknown") return kind === "open";
  const { name } = resolveFamilyName(meta, null);
  const matches = await matchGoogleFamilies([name], options);
  return matches.has(name);
}

/** A file of a face, with what its rule says about it. */
interface FaceFile {
  file: FileRecord;
  cssFamily?: string;
  unicodeRange?: string;
  coversLatin: boolean;
  loaded: boolean;
}

interface FaceRecord {
  weight: string;
  style: string;
  stretch?: string;
  loaded: boolean;
  files: FaceFile[];
  fileSet: Set<FileRecord>;
}

/**
 * Stage 1: the rules of one cleaned CSS family (key `css:`), or captured files without a rule that share a binary name
 * (`bin:`) or the one family `document.fonts` registered for them (`registered:`).
 */
interface Group {
  cssFamilies: Set<string>;
  faces: Map<string, FaceRecord>;
}

interface FamilyRecord {
  name: string;
  cssFamilies: Set<string>;
  embeddedNames: Set<string>;
  faces: Map<string, FaceRecord>;
  chars: number;
}

const FORMAT_RANK: Record<FontFormat, number> = { woff2: 0, woff: 1, ttf: 2, otf: 2, other: 3, eot: 4 };

const unquote = (family: string) => family.trim().replace(/^(["'])(.*)\1$/, "$2");
const isOk = (status: number) => status >= 200 && status < 300;
const faceKey = (cssFamily: string, face: { weight: string; style: string; stretch?: string }) =>
  JSON.stringify([cssFamily, face.weight, face.style, face.stretch ?? ""]);

function pageHostOf(page: PostInput["page"]): string {
  for (const url of [page.finalUrl, page.requestedUrl]) {
    try {
      return new URL(url).hostname;
    } catch {
      // try the next one
    }
  }
  return page.host.replace(/:\d+$/, "");
}

/**
 * Rules from the CSSOM and from captured stylesheets (cross-origin sheets the CSSOM cannot read), normalized, at most
 * `MAX_RULES_PER_SOURCE` from each. A rule found in both adds the same file to the same face twice, which `addToGroup`
 * ignores. Also returns the lowercase families of every rule, including rules with `local()` sources only.
 */
function collectRules(input: PostInput): { rules: RawFontFaceRule[]; declaredFamilies: Set<string> } {
  const sheetRules: RawFontFaceRule[] = [];
  for (const sheet of input.network.sheets) {
    const maxRules = MAX_RULES_PER_SOURCE - sheetRules.length;
    if (maxRules <= 0) break;
    if (isOk(sheet.status)) for (const rule of parseFontFaceCss(sheet.cssText, sheet.url, { maxRules })) sheetRules.push(rule);
  }
  const rules: RawFontFaceRule[] = [];
  const declaredFamilies = new Set<string>();
  for (const raw of [...input.collector.fontFaces.slice(0, MAX_RULES_PER_SOURCE), ...sheetRules]) {
    const family = unquote(raw.family);
    if (family) declaredFamilies.add(family.toLowerCase());
    const src = raw.src.flatMap((entry) => {
      const url = !entry.url ? null : isDataUri(entry.url) ? entry.url : remoteUrl(entry.url, raw.baseUrl);
      return url ? [{ url, format: entry.format }] : [];
    });
    if (!family || !src.length) continue;
    const rule: RawFontFaceRule = {
      ...raw,
      family,
      src,
      weight: normalizeWeight(raw.weight),
      style: normalizeStyle(raw.style),
      stretch: normalizeStretch(raw.stretch),
      unicodeRange: raw.unicodeRange?.trim() || undefined,
    };
    rules.push(rule);
  }
  return { rules, declaredFamilies };
}

function addToGroup(groups: Map<string, Group>, key: string, cssFamily: string | undefined, face: Omit<FaceRecord, "files" | "fileSet">, entry: FaceFile) {
  let group = groups.get(key);
  if (!group) groups.set(key, (group = { cssFamilies: new Set(), faces: new Map() }));
  if (cssFamily) group.cssFamilies.add(cssFamily);
  const id = faceKey(cssFamily ?? "", face);
  let record = group.faces.get(id);
  if (!record) group.faces.set(id, (record = { ...face, loaded: false, files: [], fileSet: new Set() }));
  record.loaded ||= face.loaded;
  if (record.fileSet.has(entry.file)) return;
  record.fileSet.add(entry.file);
  record.files.push(entry);
}

/** A captured file that no rule declares, as a loaded face of its group, with the CSS families it is known by. */
function addUndeclared(groups: Map<string, Group>, key: string, cssFamilies: string[], file: FileRecord) {
  const wght = file.meta?.axes?.find((axis) => axis.tag === "wght");
  const weight = wght ? `${wght.min} ${wght.max}` : String(file.meta?.weightClass ?? 400);
  const style = /italic|oblique/i.test(file.meta?.subfamilyName ?? "") ? "italic" : "normal";
  addToGroup(groups, key, undefined, { weight, style, loaded: true }, { file, coversLatin: file.meta?.coversLatin !== false, loaded: true });
  const group = groups.get(key)!;
  for (const family of cssFamilies) group.cssFamilies.add(family);
}

/**
 * Stage 1. Each rule gives one file: the source that loaded, else the best declared format that can be listed, which is
 * not downloaded. Rules of faces that `document.fonts` reports loaded pick first, so they come first for the `data:` URI
 * font budget. A face is loaded when a file of it was captured or `document.fonts` says so. Captured files that no rule
 * declares (fonts added with the `FontFace` API, or declared in a stylesheet that was not captured) are grouped by
 * binary name, and take as CSS families the loaded `document.fonts` families without a rule that resolve to that name
 * (`MyInter` for Inter), checking at most `MAX_UNDECLARED_NAMES` names against `MAX_REGISTERED_FAMILIES` families. Such
 * files without a binary name (unreadable bodies) take the one registered family left, and are dropped when there is
 * not exactly one. Also returns the lowercase family names that have a loaded face, for usage.
 */
function groupFiles(input: PostInput, rules: RawFontFaceRule[], declaredFamilies: Set<string>, captured: Map<string, CapturedFont>) {
  const files = createFileLookup(captured, pageHostOf(input.page));
  const statuses = input.collector.fontStatuses.map((status) => ({
    name: unquote(status.family),
    family: unquote(status.family).toLowerCase(),
    weight: normalizeWeight(status.weight),
    style: normalizeStyle(status.style),
    stretch: normalizeStretch(status.stretch),
    loaded: status.status === "loaded",
  }));
  const loaded = statuses.filter((status) => status.loaded);
  const loadedFaces = new Set(loaded.map((status) => faceKey(status.family, status)));
  const loadedFamilies = new Set(loaded.map((status) => status.family));
  const groups = new Map<string, Group>();
  const declared = new Set<string>();

  const candidates = rules.map((rule) => ({
    rule,
    files: rule.src.flatMap((entry) => {
      declared.add(entry.url!);
      const file = files.file(entry.url!, entry.format);
      return file ? [file] : [];
    }),
    statusLoaded: loadedFaces.has(faceKey(rule.family.toLowerCase(), rule)),
  }));
  const picks = new Map<(typeof candidates)[number], FileRecord>();
  for (const candidate of [...candidates.filter((entry) => entry.statusLoaded), ...candidates.filter((entry) => !entry.statusLoaded)]) {
    const file =
      candidate.files.find((entry) => entry.captured) ??
      [...candidate.files].sort((a, b) => FORMAT_RANK[a.format] - FORMAT_RANK[b.format]).find((entry) => files.take(entry));
    if (file) picks.set(candidate, file);
  }

  for (const candidate of candidates) {
    const file = picks.get(candidate);
    if (!file) continue;
    const { rule, statusLoaded } = candidate;
    if (file.captured) loadedFamilies.add(rule.family.toLowerCase());
    addToGroup(
      groups,
      `css:${cleanCssFamily(rule.family).toLowerCase()}`,
      rule.family,
      { weight: rule.weight, style: rule.style, stretch: rule.stretch, loaded: file.captured || statusLoaded },
      {
        file,
        cssFamily: rule.family,
        unicodeRange: rule.unicodeRange,
        coversLatin: coversBasicLatin(rule.unicodeRange) && file.meta?.coversLatin !== false,
        loaded: file.captured || (statusLoaded && !file.url),
      },
    );
  }

  const registered = [
    ...new Map(
      loaded
        .filter((status) => status.name && !declaredFamilies.has(status.family) && !GENERIC_FAMILIES.has(status.family))
        .map((status) => [status.family, status.name]),
    ).values(),
  ];
  const checkedFamilies = registered.slice(0, MAX_REGISTERED_FAMILIES);
  const aliasesByName = new Map<string, string[]>();
  let allChecked = registered.length <= MAX_REGISTERED_FAMILIES;
  const named = new Set<string>();
  const unnamed: FileRecord[] = [];
  for (const [url, font] of captured) {
    if (declared.has(url)) continue;
    const file = files.file(url)!;
    const name = binaryFamilyName(font.meta);
    if (!name) {
      unnamed.push(file);
      continue;
    }
    let aliases = aliasesByName.get(name);
    if (!aliases) {
      // `resolveFamilyName` reads a binary only through its family name, so files that share a name share aliases
      const check = aliasesByName.size < MAX_UNDECLARED_NAMES;
      aliases = check ? checkedFamilies.filter((family) => resolveFamilyName(font.meta, family).name.toLowerCase() === name.toLowerCase()) : [];
      allChecked &&= check;
      aliasesByName.set(name, aliases);
    }
    for (const family of aliases) named.add(family);
    loadedFamilies.add(name.toLowerCase());
    addUndeclared(groups, `bin:${name.toLowerCase()}`, aliases, file);
  }
  // Past either cap, a family could belong to a name that was not checked, so none is known to be left over
  const unclaimed = allChecked ? registered.filter((family) => !named.has(family)) : [];
  if (unclaimed.length === 1) for (const file of unnamed) addUndeclared(groups, `registered:${unclaimed[0].toLowerCase()}`, unclaimed, file);
  return { groups, loadedFamilies };
}

/** Stage 2 representative: loaded and Latin, else parsed and Latin, else parsed, else the first file. */
function representative(files: FaceFile[]): FaceFile {
  return (
    files.find((entry) => entry.loaded && entry.file.meta && entry.coversLatin) ??
    files.find((entry) => entry.file.meta && entry.coversLatin) ??
    files.find((entry) => entry.file.meta) ??
    files[0]
  );
}

/** Stages 2 and 3: name each group from its representative file, merge groups that share a display name. */
function nameFamilies(groups: Map<string, Group>) {
  const families = new Map<string, FamilyRecord>();
  const byCssFamily = new Map<string, FamilyRecord>();
  for (const [groupKey, group] of groups) {
    const rep = representative([...group.faces.values()].flatMap((face) => face.files));
    const [firstCssFamily] = group.cssFamilies;
    const resolved = resolveFamilyName(rep.file.meta, rep.cssFamily ?? firstCssFamily);
    const key = resolved.name.toLowerCase();
    let family = families.get(key);
    if (!family) families.set(key, (family = { name: resolved.name, cssFamilies: new Set(), embeddedNames: new Set(), faces: new Map(), chars: 0 }));
    for (const cssFamily of group.cssFamilies) {
      family.cssFamilies.add(cssFamily);
      byCssFamily.set(cssFamily.toLowerCase(), family);
    }
    // Stacks can also name a family without a rule by its binary name.
    if (!groupKey.startsWith("css:") && !byCssFamily.has(key)) byCssFamily.set(key, family);
    if (resolved.embeddedName) family.embeddedNames.add(resolved.embeddedName);
    for (const [id, face] of group.faces) family.faces.set(id, face);
  }
  return { families: [...families.values()], byCssFamily };
}

/** Adds characters to the first family of each stack that has a loaded face, and returns all counted characters. */
function countUsage(usage: RawFontUsage[], loadedFamilies: Set<string>, byCssFamily: Map<string, FamilyRecord>): number {
  let total = 0;
  for (const entry of usage) {
    if (!(entry.chars > 0)) continue;
    total += entry.chars;
    const used = splitFamilies(entry.stack).find((name) => loadedFamilies.has(name.toLowerCase()));
    const family = used ? byCssFamily.get(used.toLowerCase()) : undefined;
    if (family) family.chars += entry.chars;
  }
  return total;
}

/** Signs each remote URL once, in the order asked. Past the per-scan signing cap, files keep their URL with an empty `proxy`. */
function createProxySigner(signer: Signer) {
  const proxies = new Map<string, string>();
  let capped = false;
  return (url: string): string => {
    if (!url) return "";
    let proxy = proxies.get(url);
    if (proxy !== undefined) return proxy;
    proxy = "";
    if (!capped) {
      try {
        proxy = signer.sign(url);
      } catch (error) {
        if (!(error instanceof SignLimitError)) throw error;
        capped = true;
      }
    }
    proxies.set(url, proxy);
    return proxy;
  };
}

const slug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function toFaceInfo(face: FaceRecord, proxyFor: (url: string) => string | undefined): FontFaceInfo {
  const info: FontFaceInfo = { weight: face.weight, style: face.style, loaded: face.loaded, files: [] };
  if (face.stretch) info.stretch = face.stretch;
  const subfamily = face.files.find((entry) => entry.file.meta?.subfamilyName)?.file.meta?.subfamilyName;
  if (subfamily) info.subfamily = subfamily;
  info.files = face.files.map(({ file, unicodeRange, coversLatin }) => {
    const out: FontFile = { url: file.url, proxy: proxyFor(file.url) ?? "", format: file.format, coversLatin };
    if (file.bytes !== undefined) out.bytes = file.bytes;
    if (unicodeRange) out.unicodeRange = unicodeRange;
    if (file.inline) out.inline = file.inline;
    return out;
  });
  return info;
}

/**
 * Builds the font families of a scan (spec section 9) from the collector's `@font-face` rules, `document.fonts`
 * statuses and text usage, plus the captured font files and stylesheets. Families are grouped and named in three
 * stages, carry their source, licence, usage share and Google Fonts match (checked for the first
 * `limits.googleFontsMaxFamilies` used families, by display name, or only by the name in the binary when it names
 * another font), and are sorted by usage, then used before unused.
 * Remote files get a signed proxy URL, since the per-scan signing cap is shared with the assets: files that loaded
 * first, then the other files of loaded faces, then declared files, then Adobe Fonts files, which are not downloadable
 * (spec 9) but still give their font row its specimen (spec 12.3). Past that cap a remote file has an empty `proxy`, as
 * assets do. `data:` URI files carry their bytes in `inline`, with empty `url` and `proxy`, within the bounds of
 * `files.ts`.
 */
export async function buildFontFamilies(input: PostInput): Promise<FontsOutput> {
  const captured = new Map<string, CapturedFont>();
  for (const font of input.network.fonts) {
    const url = remoteUrl(font.url);
    if (url && isOk(font.status) && !captured.has(url)) captured.set(url, font);
  }
  const { rules, declaredFamilies } = collectRules(input);
  const { groups, loadedFamilies } = groupFiles(input, rules, declaredFamilies, captured);
  const { families, byCssFamily } = nameFamilies(groups);
  const totalChars = countUsage(input.collector.fontUsage, loadedFamilies, byCssFamily);

  const summaries = families.map((family) => {
    const faces = [...family.faces.values()];
    const entries = faces.flatMap((face) => face.files);
    const rep = representative(entries);
    // The licence of the first file with licence text and the axes of the first variable file: metadata is read, and
    // a data: URI file parsed, only until both are found
    let firstMeta: FontBinaryMeta | undefined;
    let licenseMeta: FontBinaryMeta | undefined;
    let axes: FontBinaryMeta["axes"];
    for (const entry of [rep, ...entries]) {
      const meta = entry.file.meta;
      if (!meta) continue;
      firstMeta ??= meta;
      if (!licenseMeta && classifyLicense(meta).kind !== "unknown") licenseMeta = meta;
      if (!axes && meta.axes?.length) axes = meta.axes;
      if (licenseMeta && axes) break;
    }
    return {
      family,
      faces,
      source: rep.file.source,
      host: rep.file.host,
      license: classifyLicense(licenseMeta ?? firstMeta, rep.file.source),
      axes,
      usage: totalChars ? Math.round((family.chars / totalChars) * 10_000) / 10_000 : 0,
      usedOnPage: family.chars > 0 || faces.some((face) => face.loaded),
    };
  });
  summaries.sort((a, b) => b.usage - a.usage || Number(b.usedOnPage) - Number(a.usedOnPage));

  // A renamed font is matched by the name in its binary only: `font-family: Lato` over a Proxima Nova file is not Lato
  const candidates = ({ family }: (typeof summaries)[number]) => (family.embeddedNames.size ? [[...family.embeddedNames][0]] : [family.name]);
  const checked = summaries.filter((summary) => summary.usedOnPage).slice(0, limits.googleFontsMaxFamilies);
  const remainingMs = input.deadline - Date.now();
  const names = checked.flatMap(candidates);
  const google =
    names.length && remainingMs > 0 && !input.signal.aborted
      ? await matchGoogleFamilies(names, { fetch: input.fetch, signal: input.signal, timeoutMs: remainingMs, maxNames: names.length })
      : new Map<string, string>();

  // Signed in the order above, since the signing cap is per scan
  const signed = createProxySigner(input.signer);
  const rank = (face: FaceRecord, entry: FaceFile) => (entry.file.source === "adobe-fonts" ? 3 : 0) + (entry.loaded ? 0 : face.loaded ? 1 : 2);
  const signable = summaries.flatMap((summary) => summary.faces.flatMap((face) => face.files.map((entry) => ({ url: entry.file.url, rank: rank(face, entry) }))));
  const proxies = new Map(signable.sort((a, b) => a.rank - b.rank).map(({ url }) => [url, signed(url)]));
  const proxyFor = (url: string) => proxies.get(url);
  const ids = new Set<string>();
  const suffixes = new Map<string, number>();
  const output = summaries.map((summary): FontFamily => {
    const base = `font-${slug(summary.family.name) || "family"}`;
    let n = suffixes.get(base) ?? 1;
    let id = n > 1 ? `${base}-${n}` : base;
    while (ids.has(id)) id = `${base}-${(n += 1)}`;
    suffixes.set(base, n);
    ids.add(id);
    const googleFamily = checked.includes(summary) ? candidates(summary).find((name) => google.has(name)) : undefined;
    const result: FontFamily = {
      id,
      name: summary.family.name,
      cssFamilies: [...summary.family.cssFamilies],
      source: summary.source,
      license: summary.license,
      convertible: summary.license.kind === "open" || (summary.license.kind === "unknown" && !!googleFamily),
      downloadable: summary.source !== "adobe-fonts",
      usedOnPage: summary.usedOnPage,
      usage: summary.usage,
      faces: summary.faces.map((face) => toFaceInfo(face, proxyFor)),
    };
    if (summary.host) result.sourceHost = summary.host;
    if (googleFamily) result.googleFamily = googleFamily;
    if (summary.axes) result.axes = summary.axes;
    return result;
  });

  return { families: output, hidden: {} };
}
