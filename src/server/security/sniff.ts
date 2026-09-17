/** Prefix that `sniffContentType` looks at: magic numbers, or an XML preamble up to `<svg`. */
export const SNIFF_BYTES = 4096;

const startsWith = (bytes: Uint8Array, text: string, offset = 0) =>
  bytes.length >= offset + text.length && Buffer.from(bytes.subarray(offset, offset + text.length)).toString("latin1") === text;

const SPACE = /\s*/y;
const XML_DECLARATION = /<\?xml[\s?]/iy;
const SVG_DOCTYPE = /<!doctype\s+svg(?=[\s>[])/iy;
const SUBSET_END = /\]\s*>/g;
const SVG_START = /<svg[\s/>]/iy;

/**
 * True when the text starts like an SVG document: a BOM, then an XML declaration, then comments, processing
 * instructions and one SVG doctype (its internal subset included) in any order, all optional, then `<svg`. One forward
 * pass with sticky patterns and `indexOf`, so the time stays linear whatever the preamble (a single regex with repeated
 * lazy comment groups backtracks exponentially).
 */
function startsLikeSvg(text: string): boolean {
  const matchEnd = (pattern: RegExp, from: number): number => {
    pattern.lastIndex = from;
    return pattern.test(text) ? pattern.lastIndex : -1;
  };
  /** Position after `close`, searched from `from`, and the whitespace that follows it; -1 when it never comes. */
  const skipPast = (close: string, from: number): number => {
    const index = text.indexOf(close, from);
    return index === -1 ? -1 : matchEnd(SPACE, index + close.length);
  };

  let position = matchEnd(SPACE, text.startsWith("\uFEFF") ? 1 : 0);
  if (matchEnd(XML_DECLARATION, position) !== -1) position = skipPast("?>", position + 5);
  let doctypeSeen = false;
  while (position !== -1) {
    if (text.startsWith("<!--", position)) {
      position = skipPast("-->", position + 4);
    } else if (text.startsWith("<?", position)) {
      // any processing instruction (`<?xml-stylesheet ...?>`), but a second XML declaration is not a document start
      if (matchEnd(XML_DECLARATION, position) !== -1) return false;
      position = skipPast("?>", position + 2);
    } else if (!doctypeSeen && matchEnd(SVG_DOCTYPE, position) !== -1) {
      doctypeSeen = true;
      const nameEnd = SVG_DOCTYPE.lastIndex;
      const close = text.indexOf(">", nameEnd);
      const subset = text.indexOf("[", nameEnd);
      if (close === -1) return false;
      if (subset === -1 || subset > close) {
        position = matchEnd(SPACE, close + 1);
      } else {
        // an internal subset (Adobe Illustrator declares its namespaces as entities there) ends at `]` and `>`
        SUBSET_END.lastIndex = subset + 1;
        position = SUBSET_END.exec(text) === null ? -1 : matchEnd(SPACE, SUBSET_END.lastIndex);
      }
    } else {
      return matchEnd(SVG_START, position) !== -1;
    }
  }
  return false;
}

/**
 * Content type from the first `SNIFF_BYTES` for the formats the asset proxy serves (spec 11.2): PNG, JPEG, GIF, WebP,
 * AVIF, ICO, WOFF, WOFF2, TTF, OTF and SVG text. Null for anything else.
 */
export function sniffContentType(input: Uint8Array): string | null {
  const bytes = input.subarray(0, SNIFF_BYTES);
  if (startsWith(bytes, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (startsWith(bytes, "\xff\xd8\xff")) return "image/jpeg";
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return "image/gif";
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "image/webp";
  if (startsWith(bytes, "ftyp", 4)) {
    const boxSize = Math.min(Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0), bytes.length);
    for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
      if (offset === 12) continue; // minor version
      if (startsWith(bytes, "avif", offset) || startsWith(bytes, "avis", offset)) return "image/avif";
    }
  }
  if (startsWith(bytes, "\x00\x00\x01\x00")) return "image/x-icon";
  if (startsWith(bytes, "wOFF")) return "font/woff";
  if (startsWith(bytes, "wOF2")) return "font/woff2";
  if (startsWith(bytes, "\x00\x01\x00\x00") || startsWith(bytes, "true")) return "font/ttf";
  if (startsWith(bytes, "OTTO")) return "font/otf";
  return startsLikeSvg(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")) ? "image/svg+xml" : null;
}
