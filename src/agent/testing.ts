import sharp from "sharp";
import type { Asset, AssetRole, FontFamily, FontFile, Palette } from "@/lib/contract";
import type { AgentScan, SelectionBudget } from "./types";

/** Factories the agent tests build scans with. Not bundled into the CLI or the MCP server. */

/** What a stubbed download reports when the test is not about the byte rules: no budget, nothing measured. */
export const noBudget: SelectionBudget = { maxTotalBytes: 0, maxFileBytes: 0, keptBytes: 0 };

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

/** The card fixture's pixel size, so a test can declare the asset dimensions that go with the bytes. */
export const TEMPLATE_CARD_WIDTH = 800;
export const TEMPLATE_CARD_HEIGHT = 600;

/**
 * One card of a set cut from a single template: identical chrome (a white ground, a title bar, two lines of body and a
 * button) and a hero photo whose fine detail is the only thing that changes. This is the case a 16x16 greyscale
 * comparison could not tell from a resize of one card, because the detail washes out at that size: the cards measure a
 * root mean square difference under 0.5 at 16x16 and a Hamming distance of 1 to 5 of 256, closer than a genuine resize,
 * while at 64x64 they measure 14 and up.
 */
export function templateCardImage(index: number): Promise<Buffer> {
  const pixels = Buffer.alloc(TEMPLATE_CARD_WIDTH * TEMPLATE_CARD_HEIGHT, 255);
  const bar = (left: number, top: number, right: number, bottom: number, value: number): void => {
    for (let y = top; y < bottom; y += 1) pixels.fill(value, y * TEMPLATE_CARD_WIDTH + left, y * TEMPLATE_CARD_WIDTH + right);
  };
  const wave = (2 * Math.PI) / 40;
  for (let y = 40; y < 340; y += 1) {
    for (let x = 40; x < 760; x += 1) {
      const gradient = 80 + ((x - 40) / 720) * 120;
      const detail = 45 * Math.sin((x - 40) * wave + index * 1.1) * Math.cos((y - 40) * wave * 0.8 + index * 2.1);
      pixels[y * TEMPLATE_CARD_WIDTH + x] = Math.max(0, Math.min(255, Math.round(gradient + detail)));
    }
  }
  bar(40, 380, 688, 406, 26);
  bar(40, 430, 540, 448, 74);
  bar(40, 470, 470, 488, 74);
  bar(40, 530, 180, 564, 26);
  return sharp(pixels, { raw: { width: TEMPLATE_CARD_WIDTH, height: TEMPLATE_CARD_HEIGHT, channels: 1 } }).png().toBuffer();
}
