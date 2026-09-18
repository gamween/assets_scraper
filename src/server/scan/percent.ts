/**
 * Percent-decoding for `data:` URI payloads, shared by the font reader and post-processing (`fonts/files.ts` pulls in
 * fontkit, so neither side imports the other).
 */

/**
 * Percent-decodes a payload, passing a lone `%` through as a byte the way browsers do. An unescaped SVG data URI
 * carries raw percent signs in gradients and percentage geometry (`x1='0%'`), and `decodeURIComponent` throws on them,
 * which would drop an image the page renders.
 */
export function percentDecode(value: string): Buffer {
  const input = Buffer.from(value, "utf8");
  const output = Buffer.alloc(input.length);
  let length = 0;
  for (let i = 0; i < input.length; i += 1) {
    const hex = input[i] === 0x25 ? input.toString("latin1", i + 1, i + 3) : "";
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      output[length++] = parseInt(hex, 16);
      i += 2;
    } else {
      output[length++] = input[i];
    }
  }
  return output.subarray(0, length);
}
