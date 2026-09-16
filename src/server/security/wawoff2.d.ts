declare module "wawoff2" {
  /** WOFF2 to TTF or OTF (sfnt) bytes. Rejects when the input is not valid WOFF2. */
  export function decompress(buffer: Uint8Array): Promise<Uint8Array>;
}
