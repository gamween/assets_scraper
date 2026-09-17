import { inflateSync } from "node:zlib";

export interface Pixels { width: number; height: number; channels: 3 | 4; data: Uint8Array }

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Minimal PNG decoder for Chromium screenshots: 8-bit RGB or RGBA, not interlaced. Throws on anything else. */
export function decodePng(buf: Uint8Array): Pixels {
  if (buf.length < 8 || SIGNATURE.some((byte, i) => buf[i] !== byte)) throw new Error("not a PNG");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 8, width = 0, height = 0;
  let channels: 3 | 4 = 4;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= buf.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7]);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      // bit depth 8, color type 2 (RGB) or 6 (RGBA), no interlacing
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 2 && body[9] !== 6)) throw new Error("unsupported PNG");
      channels = body[9] === 2 ? 3 : 4;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!width || !height || !idat.length) throw new Error("truncated PNG");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("truncated PNG");
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    if (filter > 4) throw new Error("unsupported PNG");
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y ? out[prev + x] : 0;
      const c = x >= channels && y ? out[prev + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[dst + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}
