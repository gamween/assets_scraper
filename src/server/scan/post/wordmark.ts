import { type FontFamily, type Wordmark, WordmarkTransform } from "@/lib/contract";
import { cleanCssFamily, splitFamilies } from "../fonts/names";
import { isGenericHomeLabel, MAX_WORDMARK_CHARS, MAX_WORDMARK_RUNS } from "../inpage/wordmark";
import type { AssetsOutput } from "../types";

/** The wordmark as it goes to the client (spec 8.1), from what the collector read in the page (`RawWordmark`). */

const HEX = /^#[0-9a-f]{6}$/;
const MAX_FAMILY_CHARS = 100;
/** Families of a stack read before giving up on naming one: real stacks hold a dozen at most. */
const MAX_STACK_FAMILIES = 20;
/** Largest CSS px a size, a tracking or a logo side is taken at. Past this a page is not describing a logo. */
const MAX_PX = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const finite = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/**
 * The family a wordmark is drawn in, by the scan's name for it: the first family of the stack that is a font the page
 * loaded, or that is no web font at all (a system or local font, kept as written). A web font of the stack that never
 * loaded is passed over, as the browser passed over it. investirday.fr's stack is `Inter, system-ui, sans-serif`, and a
 * next/font stack names `__Inter_d65c78`, which the scan's Inter family lists among its CSS names.
 */
export function wordmarkFamily(stack: string, families: FontFamily[]): string {
  const byCssName = new Map<string, FontFamily>();
  for (const family of families) for (const name of [family.name, ...family.cssFamilies]) if (!byCssName.has(name.toLowerCase())) byCssName.set(name.toLowerCase(), family);
  const names = splitFamilies(stack).slice(0, MAX_STACK_FAMILIES);
  for (const name of names) {
    const family = byCssName.get(name.toLowerCase());
    if (!family) return cleanCssFamily(name).slice(0, MAX_FAMILY_CHARS);
    if (family.usedOnPage) return family.name.slice(0, MAX_FAMILY_CHARS);
  }
  return cleanCssFamily(names[0] ?? "").slice(0, MAX_FAMILY_CHARS);
}

/**
 * The wordmark of the final `page` event, or undefined when the collector found none or what it sent does not hold up.
 * A main-world page can replace the collector, so every field is checked again, as `safeBrandLinks` checks the brand
 * links: at most 4 runs of non-empty text, each with a hex colour, at most 40 characters together and not a generic
 * label, and numbers a font can have. `withLogo` is kept only for an asset the scan reports.
 */
export function buildWordmark(
  raw: unknown,
  context: { families: FontFamily[]; assetIdOf?: AssetsOutput["assetIdOf"]; assetIds: ReadonlySet<string> },
): Wordmark | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.runs) || raw.runs.length === 0 || raw.runs.length > MAX_WORDMARK_RUNS) return undefined;
  const runs: Wordmark["runs"] = [];
  for (const run of raw.runs as unknown[]) {
    if (!isRecord(run) || typeof run.text !== "string" || typeof run.hex !== "string" || !HEX.test(run.hex) || !run.text.trim()) return undefined;
    const last = runs[runs.length - 1];
    if (last?.hex === run.hex) last.text += run.text;
    else runs.push({ text: run.text, hex: run.hex });
  }
  const text = runs.map((run) => run.text).join("");
  if (text !== text.trim() || text.length > MAX_WORDMARK_CHARS || isGenericHomeLabel(text)) return undefined;
  if (typeof raw.stack !== "string" || !finite(raw.weight, 1, 1000) || !finite(raw.size, 0.01, MAX_PX) || !finite(raw.letterSpacing, -MAX_PX, MAX_PX)) return undefined;
  const transform = WordmarkTransform.safeParse(raw.transform);
  const wordmark: Wordmark = {
    text,
    family: wordmarkFamily(raw.stack, context.families),
    weight: Math.round(raw.weight),
    size: round(raw.size),
    letterSpacing: round(raw.letterSpacing),
    transform: transform.success ? transform.data : "none",
    runs,
  };
  const logo = raw.logo;
  if (isRecord(logo) && finite(logo.width, 1, MAX_PX) && finite(logo.height, 1, MAX_PX)) {
    const source = typeof logo.svg === "string" ? { svg: logo.svg } : Number.isSafeInteger(logo.group) ? { group: logo.group as number } : undefined;
    const id = source && context.assetIdOf?.(source);
    if (id && context.assetIds.has(id)) wordmark.withLogo = { id, width: Math.round(logo.width), height: Math.round(logo.height) };
  }
  return wordmark;
}
