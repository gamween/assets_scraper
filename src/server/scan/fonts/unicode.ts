export type CodePointRange = [start: number, end: number];

const FULL_RANGE: CodePointRange[] = [[0, 0x10ffff]];
const PART = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i;

/**
 * Parses a CSS `unicode-range` descriptor ("U+0000-00FF, U+0131, U+4??") into inclusive code point pairs.
 * Invalid parts are skipped. A missing descriptor, or one with no valid part, covers everything, as in browsers.
 */
export function parseUnicodeRange(descriptor: string | undefined): CodePointRange[] {
  if (!descriptor) return FULL_RANGE;
  const ranges: CodePointRange[] = [];
  for (const part of descriptor.split(",")) {
    const match = PART.exec(part.trim());
    if (!match) continue;
    const [, start, end] = match;
    if (start.includes("?")) {
      if (end || /\?[0-9a-f]/i.test(start)) continue;
      ranges.push([parseInt(start.replace(/\?/g, "0"), 16), parseInt(start.replace(/\?/g, "f"), 16)]);
      continue;
    }
    ranges.push([parseInt(start, 16), parseInt(end ?? start, 16)]);
  }
  return ranges.length ? ranges : FULL_RANGE;
}

export const rangeCovers = (ranges: CodePointRange[], codePoint: number): boolean =>
  ranges.some(([start, end]) => codePoint >= start && codePoint <= end);

/** True when the range includes both "A" and "a", the check used to pick the Latin file of a subset family. */
export function coversBasicLatin(descriptor: string | undefined): boolean {
  const ranges = parseUnicodeRange(descriptor);
  return rangeCovers(ranges, 0x41) && rangeCovers(ranges, 0x61);
}
