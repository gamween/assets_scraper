import type { FontFaceInfo, FontFamily, FontFile, FontFormat } from "@/lib/contract";

/**
 * Which file a family installs from (spec 5.1), in one place for the two sides that answer the question. The scan
 * summary says `installable` from it, and `installFonts` walks the same list: the summary used to keep its own copy
 * of the rule, which ignored `coversLatin` and counted WOFF 1 as convertible, so an icon font or a `.woff` only family
 * read `installable: true` on `scan_page` and then failed on `install_fonts`.
 */

/** Why a family has no file to install, before anything is fetched. */
export type NoCandidateReason = "adobe-fonts" | "not-downloadable" | "no-latin-file" | "unsupported-format";

/** Formats the installer can write: WOFF2 and WOFF are decompressed to the sfnt they wrap, TTF and OTF install as they are. */
const INSTALLABLE_FORMATS = new Set<FontFormat>(["woff2", "woff", "ttf", "otf"]);
/** Formats that need no conversion, best first: installing them costs nothing and cannot fail. */
const NATIVE_FORMATS: FontFormat[] = ["ttf", "otf"];

export const WEIGHT_NAMES = new Map([
  [100, "Thin"], [200, "ExtraLight"], [300, "Light"], [400, "Regular"], [500, "Medium"],
  [600, "SemiBold"], [700, "Bold"], [800, "ExtraBold"], [900, "Black"],
]);

/** The numbers a `font-weight` names, or null for a range or a keyword this does not know. */
export function weightOf(weight: string): number | null {
  const words = weight.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 1) return null; // a variable range ("100 900"): the family installs as its regular face
  const [word] = words;
  if (word === "normal") return 400;
  if (word === "bold") return 700;
  const value = Number(word);
  if (!Number.isFinite(value)) return null;
  return [...WEIGHT_NAMES.keys()].reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best), 400);
}

export const isItalic = (style: string): boolean => /italic|oblique/i.test(style);

/** Whether the bytes of a file can be had at all: they travel inline, or there is a URL to fetch them from. */
const hasBytes = (file: FontFile): boolean => file.inline !== undefined || file.url !== "";

export interface FontCandidate {
  face: FontFaceInfo;
  file: FontFile;
}

/**
 * The files a family could install from, best first: a loaded face, then the variable font, then upright, then the
 * weight nearest regular, then a file that needs no conversion. Or the reason there is none. The installer takes the
 * first one it can fetch and convert, and falls back down the list when one cannot, so a `src` that lists a broken
 * file first still installs from the next.
 */
export function fontCandidates(family: FontFamily): { candidates: FontCandidate[] } | { reason: NoCandidateReason } {
  // Adobe Fonts kits are excluded before anything else: the scan never exposes their bytes (spec 5).
  if (family.source === "adobe-fonts") return { reason: "adobe-fonts" };
  if (!family.downloadable) return { reason: "not-downloadable" };
  const latin: FontCandidate[] = family.faces.flatMap((face) => face.files.filter((file) => file.coversLatin).map((file) => ({ face, file })));
  if (latin.length === 0) return { reason: "no-latin-file" };
  const supported = latin.filter(({ file }) => INSTALLABLE_FORMATS.has(file.format));
  if (supported.length === 0) return { reason: "unsupported-format" };
  const reachable = supported.filter(({ file }) => hasBytes(file));
  if (reachable.length === 0) return { reason: "not-downloadable" };

  const rank = ({ face, file }: FontCandidate): number[] => [
    face.loaded ? 0 : 1,
    weightOf(face.weight) === null ? 0 : 1,
    isItalic(face.style) ? 1 : 0,
    Math.abs((weightOf(face.weight) ?? 400) - 400),
    NATIVE_FORMATS.includes(file.format) ? 0 : 1,
  ];
  const candidates = [...reachable].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
    return 0;
  });
  return { candidates };
}

/**
 * Whether `installFonts` has a file to install this family from. The licence does not decide it: a commercial family
 * installs too, with its licence reported (spec 5.5). A file that turns out not to decode is only known once fetched.
 */
export const isInstallableFamily = (family: FontFamily): boolean => "candidates" in fontCandidates(family);
