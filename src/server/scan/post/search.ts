/**
 * How post-processing looks for markers in page text it cannot bound, SVG markup and `sizes` attributes: a pattern
 * over the whole text that can match from any start position (`<svg\b[^>]*>`, `<symbol\b[\s\S]*?</symbol>`) reads from
 * every start to the end of the text when the match fails, and one scraped SVG of `<svg<svg<svg` held the event loop
 * for minutes. A scanner instead calls `searchFrom` for one short marker at a time, each search starting past the
 * previous match, so it reads every character once.
 *
 * `searchFrom` is exported on its own so the op-count tests can count the characters each search steps over.
 */

/** The next match of `pattern` in `text` at or after `from`, or null. `pattern` must be global or sticky. */
export function searchFrom(text: string, pattern: RegExp, from: number): RegExpExecArray | null {
  if (!pattern.global && !pattern.sticky) throw new TypeError("searchFrom needs a global or sticky pattern");
  pattern.lastIndex = from;
  return pattern.exec(text);
}
