declare module "wawoff2/decompress" {
  /** Converts WOFF2 bytes to TTF bytes. Rejects when the input is not valid WOFF2. */
  const decompress: (buffer: Uint8Array) => Promise<Uint8Array>;
  export default decompress;
}
