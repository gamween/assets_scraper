import type { Asset, FontFamily, FontFile } from "@/lib/contract";

/** Test factories shared by the client library tests. Not imported by app code. */

export function makeAsset(partial: Partial<Asset> & { id: string }): Asset {
  const kind = partial.kind ?? "image";
  const format = partial.format ?? (kind === "svg" ? "svg" : "png");
  return {
    kind,
    role: "image",
    name: partial.id,
    filename: `${partial.id}.${format === "jpg" ? "jpg" : format}`,
    format,
    foundIn: [kind === "svg" ? "inline-svg" : "img"],
    visible: true,
    declaredOnly: false,
    order: 0,
    score: 100,
    usedCount: 1,
    tone: "unknown",
    display: null,
    original: null,
    ...partial,
  };
}

export function remoteSource(url: string, extra: Partial<Asset["original"] & object> = {}) {
  return {
    url,
    proxy: `/api/asset?u=${Buffer.from(url).toString("base64url")}&e=1&s=sig`,
    format: "png" as const,
    ...extra,
  };
}

export function makeFontFile(partial: Partial<FontFile> = {}): FontFile {
  return { url: "https://cdn.test/font.woff2", proxy: "/api/asset?u=Zm9udA&e=1&s=sig", format: "woff2", coversLatin: true, ...partial };
}

export function makeFont(partial: Partial<FontFamily> & { id: string }): FontFamily {
  return {
    name: partial.id,
    cssFamilies: [partial.id],
    source: "self-hosted",
    license: { kind: "unknown" },
    convertible: false,
    downloadable: true,
    usedOnPage: true,
    usage: 0.5,
    faces: [{ weight: "400", style: "normal", loaded: true, files: [makeFontFile()] }],
    ...partial,
  };
}
