/**
 * Text on its way to a terminal: the CLI's human report. A page controls its title and its font family names, and both
 * keep their control characters all the way here (`&#27;` in a title, `\1b` in a CSS family name), so printing them
 * raw let a page drive the user's terminal: `ESC ] 52` replaces the clipboard in kitty, Ghostty and WezTerm, and
 * `ESC [ 1A ESC [ 2K` erases the licence warning printed above. The `--json` output needs none of this, since
 * `JSON.stringify` escapes every control character.
 */

/** C0 and C1 controls, DEL, and the bidi overrides and isolates that reorder what a terminal shows. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const LINE_BREAKS = /[\t\n\r]/g;

/** One value on one line: line breaks and tabs become spaces, every other control a replacement character. */
export const printable = (text: string): string => text.replace(LINE_BREAKS, " ").replace(UNPRINTABLE, "�");

/** A whole report: its own line breaks kept, every other control replaced. The guard behind `printable`, not instead of it. */
export const terminalText = (report: string): string =>
  report
    .split("\n")
    .map((line) => line.replace(UNPRINTABLE, "�"))
    .join("\n");
