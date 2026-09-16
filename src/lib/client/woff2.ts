/**
 * WOFF2 to TTF in the browser (spec 9), for inline font files that the proxy cannot convert. wawoff2 embeds its
 * WebAssembly module (about 320 KB), so it only loads on first use.
 */
let decompressor: Promise<(bytes: Uint8Array) => Promise<Uint8Array>> | null = null;

export async function woff2ToTtf(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  decompressor ??= import("wawoff2/decompress").then((module) => module.default);
  const decompress = await decompressor;
  const result = await decompress(bytes);
  return new Uint8Array(result);
}

export const isWoff2 = (bytes: Uint8Array) => bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32;
