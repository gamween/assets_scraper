/**
 * The wordmark rules (spec 8.1): when the text of the page's home link is the live text the page sets as its logo, and
 * how its pieces become colour runs. One file the in-page collector bundles and post-processing reads in Node, pure
 * string and number work, so the unit tests read it directly. The collector does the DOM part: which home link, which
 * text a reader sees, which style it has.
 */

/**
 * Characters a wordmark has at most. investirday.fr's is 12 ("Investir" over "Day"); past 40 the home link holds a
 * sentence, a tagline or a banner, not a name.
 */
export const MAX_WORDMARK_CHARS = 40;

/** Colour runs a wordmark has at most: investirday.fr has two, "Investir" and then "Day" in its accent colour. */
export const MAX_WORDMARK_RUNS = 4;

/**
 * Text a home link holds when it is a menu item or a skip link rather than a name: ilovechickpea.ca's nav opens on a
 * "HOME" link to its home page, ui.shadcn.com's on "Home". The whole text has to be one of these, in any case.
 */
const GENERIC_HOME_LABEL =
  /^(?:(?:back|go|return)(?: to)?(?: the)? )?(?:home|home ?page|main page|start|start ?page|startseite|accueil|page d'accueil|retour (?:à|a) l'accueil|inicio|início|pagina principale|página principal|hjem|hem|koti|strona główna|главная|首页|主页|ホーム|홈|menu|logo|skip to (?:main )?content|skip navigation|aller au contenu)$/i;

export const isGenericHomeLabel = (text: string): boolean => GENERIC_HOME_LABEL.test(text.replace(/[.!:>→←»«]+/g, " ").replace(/\s+/g, " ").trim());

/**
 * Characters that take no room: investirday.fr ends its wordmark with a `<span>` holding a lone U+200B, set in another
 * font and in the accent colour, which would otherwise be a third run.
 */
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;

export const stripInvisible = (text: string): string => text.replace(INVISIBLE, "");

export interface WordmarkRun {
  text: string;
  hex: string;
}

/** One text node of a home link: its text, the colour it is seen in, and whether it starts a line of its own. */
export interface WordmarkPiece extends WordmarkRun {
  newLine?: boolean;
}

/**
 * The pieces of a home link's text, one per text node in order, as colour runs: invisible characters out, white space
 * collapsed, one space kept where the page has some between two pieces (`<span>Acme</span> <span>Labs</span>`), a line
 * break where a piece starts a line of its own, and neighbours of one colour merged. A piece of white space alone only
 * separates. A space or a break between two runs ends the first one.
 */
export function colourRuns(pieces: WordmarkPiece[]): WordmarkRun[] {
  const runs: WordmarkRun[] = [];
  let space = false;
  for (const piece of pieces) {
    const text = stripInvisible(piece.text).replace(/\s+/g, " ");
    if (!text.trim()) {
      space ||= text.length > 0;
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && piece.newLine) last.text += "\n";
    else if (last && (space || text.startsWith(" "))) last.text += " ";
    if (last && last.hex === piece.hex) last.text += text.trim();
    else runs.push({ text: text.trim(), hex: piece.hex });
    space = text.endsWith(" ");
  }
  return runs;
}

/** The typography of a stretch of text, from its computed style. */
export interface TextStyle {
  /** The first family of the computed stack, unquoted and in lower case: what tells two stacks apart. */
  family: string;
  weight: number;
  size: number;
  letterSpacing: number;
  transform: string;
}

/** `12px` to 12, and `normal` or anything unreadable to 0: computed lengths are always in px. */
export const px = (value: string): number => {
  const number = parseFloat(value);
  return Number.isFinite(number) ? number : 0;
};

/**
 * The weight the text is drawn at. A variable font can take it from `font-variation-settings`, which then wins over
 * `font-weight`: framer.com sets "Framer" beside its mark with `"wght" 600`, and its computed `font-weight` reads 400.
 */
export function drawnWeight(fontWeight: string, variationSettings: string): number {
  const axis = /["']wght["']\s+(-?[\d.]+)/.exec(variationSettings);
  const weight = parseFloat(axis ? axis[1] : fontWeight);
  return Number.isFinite(weight) ? weight : 400;
}

/** The first family of a computed `font-family` stack, unquoted, in lower case. */
export const firstFamily = (stack: string): string => (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();

/** A letter-spacing that differs by less than this share of the font size is the same tracking. */
const TRACKING_EM = 0.02;
/** A size at least this much larger than the links beside it is a heading, not a menu item. */
const LARGER = 1.1;
const HEAVY = 600;

/**
 * Whether a home link's text is set apart from the links beside it, which is what makes it a wordmark rather than a
 * menu item that happens to lead home. Any one of these is enough: its own family, a weight of 600 or more that its
 * neighbours do not have, its own tracking, its own case, a size 10 percent larger, or a picture beside it in the same
 * link (a lockup, whose text is part of the logo however it is set). `peer` is the style most of the other links of
 * the header or nav share, or the body's when it has none.
 *
 * The comparison is with the neighbours rather than with fixed values because a nav can be bold, tracked and in
 * capitals throughout: allbirds.com sets its menu in 500, 0.6 px, uppercase, gymshark.com in 700. A home link set like
 * them is one more item of that menu.
 */
export function isSetApart(own: TextStyle, peer: TextStyle, besidePicture: boolean): boolean {
  if (besidePicture) return true;
  return (
    own.family !== peer.family ||
    (own.weight >= HEAVY && own.weight > peer.weight) ||
    Math.abs(own.letterSpacing - peer.letterSpacing) >= TRACKING_EM * own.size ||
    own.transform !== peer.transform ||
    own.size >= peer.size * LARGER
  );
}

/** The style most of `styles` share, the first of them on a tie, or undefined for none. */
export function commonStyle(styles: TextStyle[]): TextStyle | undefined {
  const counts = new Map<string, { style: TextStyle; count: number }>();
  for (const style of styles) {
    const key = `${style.family}|${style.weight}|${style.size}|${style.letterSpacing}|${style.transform}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { style, count: 1 });
  }
  let best: { style: TextStyle; count: number } | undefined;
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
  return best?.style;
}
