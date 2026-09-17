import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * Tiny PNG encoder and a generator of stand-in images, so the e2e suite can serve every remote asset offline.
 * Pictures are derived from a seed (the URL): opaque gradients for photos, light or dark marks on transparency for
 * logos and icons, which exercises the tone-based preview backgrounds.
 */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 3 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

type Rgb = [number, number, number];

const hsl = (h: number, s: number, l: number): Rgb => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
};

export type StandInTone = "light" | "dark" | "mixed" | "opaque" | "unknown";

export function standInPng(seed: string, width: number, height: number, tone: StandInTone): Buffer {
  const scale = Math.min(1, 480 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const hash = createHash("sha1").update(seed).digest();
  const hue = (hash[0] / 255) * 360;
  const rgba = new Uint8Array(w * h * 4);
  const set = (i: number, [r, g, b]: Rgb, a: number) => {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  };

  if (tone === "opaque") {
    const from = hsl(hue, 0.45, 0.28 + (hash[1] / 255) * 0.3);
    const to = hsl((hue + 40 + hash[2] / 4) % 360, 0.55, 0.62 + (hash[3] / 255) * 0.2);
    const cx = w * (0.3 + (hash[4] / 255) * 0.4);
    const cy = h * (0.3 + (hash[5] / 255) * 0.4);
    const radius = Math.min(w, h) * 0.28;
    const card = { x: w * 0.12, y: h * 0.62, w: w * 0.5, h: h * 0.16 };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = (x / w + y / h) / 2;
        let color: Rgb = [0, 1, 2].map((c) => Math.round(from[c] + (to[c] - from[c]) * t)) as Rgb;
        const d = Math.hypot(x - cx, y - cy);
        if (d < radius) color = color.map((c) => Math.min(255, c + 38)) as Rgb;
        if (x > card.x && x < card.x + card.w && y > card.y && y < card.y + card.h) color = [245, 245, 247];
        set((y * w + x) * 4, color, 255);
      }
    }
    return encodePng(w, h, rgba);
  }

  const ink: Rgb = tone === "light" ? [246, 246, 248] : tone === "dark" ? [24, 24, 27] : hsl(hue, 0.55, 0.52);
  const glyph: Rgb = tone === "light" ? [24, 24, 27] : tone === "dark" ? [246, 246, 248] : [255, 255, 255];
  const inset = Math.min(w, h) * 0.12;
  const corner = Math.min(w, h) * 0.22;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = x >= inset && x < w - inset && y >= inset && y < h - inset;
      if (!inside) continue;
      const dx = Math.max(inset + corner - x, x - (w - inset - corner), 0);
      const dy = Math.max(inset + corner - y, y - (h - inset - corner), 0);
      if (Math.hypot(dx, dy) > corner) continue;
      // A soft transparent edge and a simple glyph, like an app icon.
      const edge = Math.hypot(dx, dy) > corner - 1.5 ? 140 : 255;
      const inGlyph = Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) * 0.16;
      set(i, inGlyph ? glyph : ink, edge);
    }
  }
  return encodePng(w, h, rgba);
}
