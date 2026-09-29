import type { AssetFormat, AssetSource, FontFile, FontFormat } from "@/lib/contract";
import { isAllowedDeclaredType, sniffContentType, UNTYPED } from "@/server/security/sniff";

export { declaredType } from "@/server/security/sniff";

/**
 * The content-type allowlist the agent paths owe their callers (spec section 10: "the ZIP endpoint applies the v1 asset
 * caps, the proxy byte budget and the content-type allowlist"). It is the check `handleAssetRequest` runs for the
 * browser, in the one place the agent core reads bytes off the network: `ScanSource.fetchBytes`.
 *
 * Why it cannot be left to the scan's own classification: a scan is cached for an hour, so `download_assets` refetches a
 * URL up to 60 minutes after the scanner looked at it. A page that serves a real PNG while it is scanned and arbitrary
 * bytes afterwards would otherwise have that answer written to disk as `images/hero.png`, with `manifest.json` asserting
 * `format: "png"`, and streamed out of `/api/v1/assets.zip` for an agent to unzip and trust.
 *
 * Everything `fetchBytes` returns goes through this, an inline font file included, and so do the bytes an asset carries
 * inline, which the download and the archive read straight out of the scan (`inlineAssetBytes` in `entries.ts`): a
 * `data:` URI is only as honest as the page that wrote it, and a remote answer only as honest as the host that sent it.
 */

/** A file whose bytes are not the kind of file the scan said they were. Reported under `failed`, never thrown outward. */
export class UnsupportedBytesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedBytesError";
  }
}

/** Formats only a font file has. `other` is in both enums, so it is deliberately not here: it accepts either class. */
const FONT_FORMATS = new Set<string>(["woff2", "woff", "ttf", "otf", "eot"]);

/**
 * Refuses a declared content type that is not an image or a font, before the body is read. It is the proxy's own rule
 * (`isAllowedDeclaredType`, with untyped bodies left to their magic numbers), so a page that answers `text/html` for the
 * URL of an image costs nothing to refuse.
 */
export function assertDeclaredType(declared: string, subject: string): void {
  if (UNTYPED.has(declared) || isAllowedDeclaredType(declared)) return;
  throw new UnsupportedBytesError(`${subject} answered with ${declared}, which is not an image or a font`);
}

/**
 * Refuses bytes whose magic numbers are not the class of file the scan reported: nothing the sniffer recognizes at all,
 * an image where a font was expected, or anything but SVG markup for an SVG. A format the sniffer does not know (BMP,
 * and anything exotic) is refused rather than written, which is the safe direction for a file that lands on a disk.
 */
export function assertSupportedBytes(bytes: Buffer, format: AssetFormat | FontFormat, subject: string): void {
  const sniffed = sniffContentType(bytes);
  if (sniffed === null) throw new UnsupportedBytesError(`the bytes of ${subject} are not a supported image or font, whatever it declared`);
  const wanted =
    format === "svg" ? "image/svg+xml"
    : FONT_FORMATS.has(format) ? "font/"
    : format === "other" ? ""
    : "image/";
  if (wanted !== "" && !sniffed.startsWith(wanted)) {
    throw new UnsupportedBytesError(`the bytes of ${subject} are ${sniffed}, not the ${format} the scan reported`);
  }
}

/**
 * The bytes a file carries itself, checked like fetched ones, or null when it has to be fetched. Only a font file does
 * (`FontFile.inline`, a family declared as a `data:` URI), and both scan sources answer it the same way.
 */
export function inlineFileBytes(target: AssetSource | FontFile): Buffer | null {
  const inline = "inline" in target ? target.inline : undefined;
  if (!inline) return null;
  const decoded = Buffer.from(inline.base64, "base64");
  assertSupportedBytes(decoded, target.format, "this inline file");
  return decoded;
}
