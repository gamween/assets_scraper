/**
 * `srcset` parsing for the in-page collector (`<img>`, `<source>`, lazy attributes), in a module of its own like
 * `lists.ts`: the collector bundles it, and the unit tests read the same copy in Node.
 */

export interface SrcsetCandidate {
  url: string;
  w?: number;
  x?: number;
}

/** HTML-style srcset parser: a URL runs until whitespace, so commas inside URLs (Cloudinary `w_500,c_fill`) are kept. */
export function parseSrcset(value: string | null | undefined): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  if (!value) return out;
  const s = value;
  const n = s.length;
  const space = /\s/;
  let i = 0;
  while (i < n) {
    while (i < n && (s[i] === "," || space.test(s[i]))) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !space.test(s[i])) i++;
    let url = s.slice(start, i);
    let descriptor = "";
    if (/,+$/.test(url)) {
      url = url.replace(/,+$/, "");
    } else {
      let depth = 0;
      const descriptorStart = i;
      while (i < n) {
        const c = s[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth <= 0) break;
        i++;
      }
      descriptor = s.slice(descriptorStart, i).trim();
      i++;
    }
    if (!url) continue;
    // The digit runs are bounded and the alternation removes the `\d*`/`\d+` overlap: the unbounded form is cubic in
    // the descriptor length, so one long digit run blocks the caller for minutes. Nine digits is far beyond any real
    // descriptor, and a longer run is not a number `Number()` could use.
    const w = descriptor.match(/(\d{1,9})w\b/);
    const x = descriptor.match(/(\d{1,9}(?:\.\d{1,9})?|\.\d{1,9})x\b/);
    if (w) out.push({ url, w: Number(w[1]) });
    else out.push({ url, x: x ? Number(x[1]) : 1 });
  }
  return out;
}
