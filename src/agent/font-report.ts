import type { FontInstallReport, FontSkipReason, FontUninstallReport } from "./fonts";
import { printable } from "./terminal";
import type { FontInstall } from "./types";

/**
 * What the CLI prints about fonts: the licence of everything it installed, commercial ones included, which is the notice
 * the user is agreeing to (spec 5.5), and a reason in words for every family it could not install. Every family name,
 * licence and host is page text, so each goes through `printable` before it reaches the terminal.
 */

/** How the report explains a family it could not install. */
export const FONT_SKIP_LABELS: Record<FontSkipReason, string> = {
  "adobe-fonts": "Adobe Fonts never exposes the file",
  "not-downloadable": "the page gives no file to download",
  "no-latin-file": "no loaded file covers Basic Latin",
  "unsupported-format": "the format cannot be installed",
  "fetch-failed": "the file could not be fetched",
  "too-large": "the file is larger than the install limit",
  "conversion-failed": "the file could not be converted to TTF",
  exists: "a file of that name is already there and this tool did not write it",
  "write-failed": "the font directory refused the file",
  "unknown-family": "no family of that name on this page",
};

/** One line of licence, whatever the binary carried: a copyright notice can run to paragraphs. */
const oneLineLicence = (text: string): string => printable(text).replace(/\s+/g, " ").trim().slice(0, 160);

/** The licence, printed for every install including a commercial one, which is the whole point of spec 5.5. */
function licenceLine(install: FontInstall): string {
  const text = install.license.text ? ` (${oneLineLicence(install.license.text)})` : "";
  const note = install.license.kind === "open" ? "" : ". Read it before you ship anything with this font";
  return `${printable(install.family)}: ${install.license.kind} licence${text}${note}`;
}

export function formatFontInstall(report: FontInstallReport): string {
  const rows: string[] = [];
  for (const install of report.installed) {
    rows.push(licenceLine(install));
    for (const file of install.files) rows.push(`  ${printable(file)}${install.converted ? " (converted to TTF)" : ""}`);
  }
  for (const skipped of report.skipped) {
    const detail = skipped.detail === undefined ? "" : `: ${printable(skipped.detail)}`;
    rows.push(`${printable(skipped.family)}: not installed, ${FONT_SKIP_LABELS[skipped.reason] ?? skipped.reason}${detail}`);
  }
  if (report.installed.length === 0 && report.skipped.length === 0) rows.push("no font family to install on this page");
  rows.push(`font directory: ${printable(report.fontDir)}`);
  return rows.join("\n");
}

export function formatFontList(fonts: FontInstall[]): string {
  if (fonts.length === 0) return "this tool has installed no font yet";
  const rows: string[] = [];
  for (const font of fonts) {
    rows.push(licenceLine(font));
    rows.push(`  from ${printable(font.sourceHost)}, installed ${printable(font.installedAt.slice(0, 10))}`);
    for (const file of font.files) rows.push(`  ${printable(file)}`);
  }
  return rows.join("\n");
}

export function formatFontUninstall(result: FontUninstallReport): string {
  const rows: string[] = [];
  for (const font of result.removed) {
    rows.push(`removed ${printable(font.family)}`);
    for (const file of font.files) rows.push(`  ${printable(file)}`);
  }
  for (const family of result.missing) rows.push(`${printable(family)}: this tool did not install it, nothing removed`);
  for (const still of result.stillInstalled) {
    rows.push(`${printable(still.family)}: still installed, none of its files could be removed`);
    for (const file of still.files) rows.push(`  ${printable(file)}`);
  }
  for (const changed of result.changed) {
    rows.push(`${printable(changed.family)}: left in place, these files are no longer the ones this tool installed`);
    for (const file of changed.files) rows.push(`  ${printable(file)}`);
  }
  if (rows.length === 0) rows.push("nothing to remove");
  return rows.join("\n");
}
