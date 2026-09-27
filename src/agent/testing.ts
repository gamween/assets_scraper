import type { Asset, AssetRole, FontFamily, FontFile, Palette } from "@/lib/contract";
import type { AgentScan } from "./types";

/** Factories the agent tests build scans with. Not bundled into the CLI or the MCP server. */

export function testAsset(patch: Partial<Asset> & { id: string }): Asset {
  const format = patch.format ?? (patch.kind === "svg" ? "svg" : "png");
  return {
    kind: format === "svg" ? "svg" : "image",
    role: "image",
    name: patch.id,
    filename: `${patch.id}.${format}`,
    format,
    foundIn: ["img"],
    visible: true,
    declaredOnly: false,
    order: 0,
    score: 50,
    usedCount: 1,
    tone: "unknown",
    display: { url: `https://cdn.example.com/${patch.id}.${format}`, proxy: "", format },
    original: null,
    ...patch,
  };
}

export function testFontFile(patch: Partial<FontFile> = {}): FontFile {
  return { url: "https://cdn.example.com/inter.woff2", proxy: "", format: "woff2", coversLatin: true, ...patch };
}

export function testFontFamily(patch: Partial<FontFamily> & { name: string }): FontFamily {
  return {
    id: patch.name.toLowerCase(),
    cssFamilies: [patch.name],
    source: "self-hosted",
    sourceHost: "cdn.example.com",
    license: { kind: "open", text: "SIL Open Font License" },
    convertible: true,
    downloadable: true,
    usedOnPage: true,
    usage: 0.5,
    faces: [{ weight: "400", style: "normal", loaded: true, files: [testFontFile()] }],
    ...patch,
  };
}

const palette: Palette = {
  brand: [
    { hex: "#635bff", role: "primary" },
    { hex: "#0a2540", role: "accent" },
  ],
  neutrals: [
    { hex: "#ffffff", role: "background" },
    { hex: "#f6f9fc", role: "surface" },
    { hex: "#425466", role: "text" },
  ],
};

export function testScan(patch: Partial<AgentScan> = {}): AgentScan {
  const roles: AssetRole[] = ["site-logo", "logo", "logo", "social", "illustration", "image", "icon", "favicon"];
  const assets = Array.from({ length: 236 }, (_, index) =>
    testAsset({
      id: `asset-${index}`,
      role: roles[index % roles.length],
      order: index,
      score: 100 - index,
      width: 1200,
      height: 800,
    }),
  );
  return {
    scanId: "scan-1",
    scannedAt: "2026-09-27T10:00:00.000Z",
    source: "local",
    page: { url: "https://stripe.com", finalUrl: "https://stripe.com/", host: "stripe.com", title: "Stripe", siteName: "Stripe" },
    assets,
    fonts: [testFontFamily({ name: "Inter" }), testFontFamily({ name: "Söhne", license: { kind: "commercial", text: "Copyright Klim Type Foundry" } })],
    palette,
    stats: { assets: assets.length, svg: 40, images: 196, fonts: 2, hidden: { tracker: 3, pixel: 9 }, durationMs: 12_345 },
    warnings: [],
    ...patch,
  };
}
